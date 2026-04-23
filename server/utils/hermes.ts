import type { BlockKind } from '~/shared/types'
import { stringify, truncatePreview } from '~/shared/text'

const log = createLog('hermes')

export interface BlockHandlers {
  onBlockStart: (blockId: string, kind: BlockKind, meta: { tool?: string }) => void
  onBlockDelta: (blockId: string, text: string) => void
  onBlockEnd: (blockId: string, text: string) => void
  /**
   * Fires when a speakable chunk is ready — one paragraph of message text, delimited by `\n`.
   * Pipeline uses this to synthesize TTS as the model streams instead of waiting for the full turn.
   */
  onSpeakChunk: (text: string) => void
}

interface ResponseItem {
  id?: string
  type?: string
  name?: string
  call_id?: string
  arguments?: string
  output?: unknown
  role?: string
  content?: Array<{ type?: string; text?: string }>
  [key: string]: unknown
}

interface SSEData {
  type?: string
  item?: ResponseItem
  item_id?: string
  delta?: string
  error?: { message?: string }
  [key: string]: unknown
}

/** Per-Hermes-message-item streaming state. We split its content on `\n` into synthetic sub-blocks. */
interface MessageChunking {
  itemId: string
  chunkIdx: number
  /** Empty string while no chunk is open; set when content first arrives after a newline split. */
  currentBlockId: string
  currentText: string
  /** Total characters (including swallowed newlines) we've consumed from this item's stream — used to reconcile against the final content on item.done. */
  totalEmitted: number
}

export async function respond(
  input: string,
  conversationId: string,
  handlers: BlockHandlers,
): Promise<{ finalMessage: string }> {
  const body = {
    model: config.HERMES_MODEL,
    input,
    conversation: conversationId,
    store: true,
    stream: true,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  const t0 = performance.now()
  const ts = () => `+${Math.round(performance.now() - t0)}ms`
  log.info(`${ts()} POST ${config.HERMES_API_URL}/responses model=${config.HERMES_MODEL} conv=${conversationId}`)

  let response: Response
  try {
    response = await fetch(`${config.HERMES_API_URL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.HERMES_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Hermes request timed out after 120s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`Hermes ${response.status}: ${text}`)
  }
  if (!response.body) throw new Error('Hermes returned no body for streaming request')
  log.info(`${ts()} response status=${response.status}`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let gotFirstByte = false
  let firstContentAtMs: number | null = null
  let currentEvent: string | null = null

  /** Tracks every synthetic and native block we emit, keyed by the blockId sent to the client. */
  const blocks = new Map<string, { kind: BlockKind; text: string }>()
  const blockOrder: string[] = []
  /** Per-Hermes-message chunking state, keyed by Hermes's item.id. */
  const messageStates = new Map<string, MessageChunking>()
  let eventCount = 0
  let unhandledLogged = 0

  function registerBlock(blockId: string, kind: BlockKind): void {
    blocks.set(blockId, { kind, text: '' })
    blockOrder.push(blockId)
  }

  function ensureChunkStarted(state: MessageChunking): void {
    if (state.currentBlockId) return
    state.chunkIdx += 1
    state.currentBlockId = `${state.itemId}.${state.chunkIdx}`
    state.currentText = ''
    registerBlock(state.currentBlockId, 'message')
    handlers.onBlockStart(state.currentBlockId, 'message', {})
  }

  function closeCurrentChunk(state: MessageChunking): void {
    if (!state.currentBlockId) return
    const text = state.currentText
    const rec = blocks.get(state.currentBlockId)
    if (rec) rec.text = text
    handlers.onBlockEnd(state.currentBlockId, text)
    const trimmed = text.trim()
    if (trimmed) {
      handlers.onSpeakChunk(trimmed)
      log.info(`${ts()} chunk ${state.currentBlockId} speak (${trimmed.length}ch) → "${truncatePreview(trimmed, 200)}"`)
    }
    state.currentBlockId = ''
    state.currentText = ''
  }

  /** Feed text into the chunking state, splitting on any run of `\n` characters. */
  function processMessageText(state: MessageChunking, text: string): void {
    let remaining = text
    while (remaining.length > 0) {
      const idx = remaining.indexOf('\n')
      if (idx === -1) {
        ensureChunkStarted(state)
        state.currentText += remaining
        handlers.onBlockDelta(state.currentBlockId, remaining)
        state.totalEmitted += remaining.length
        return
      }
      const before = remaining.slice(0, idx)
      if (before) {
        ensureChunkStarted(state)
        state.currentText += before
        handlers.onBlockDelta(state.currentBlockId, before)
        state.totalEmitted += before.length
      }
      let run = 1
      while (idx + run < remaining.length && remaining[idx + run] === '\n') run += 1
      state.totalEmitted += run

      if (firstContentAtMs === null && (state.currentText.length > 0 || before.length > 0)) {
        firstContentAtMs = performance.now() - t0
      }
      closeCurrentChunk(state)
      remaining = remaining.slice(idx + run)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!gotFirstByte) {
        gotFirstByte = true
        log.info(`${ts()} TTFB`)
      }

      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          currentEvent = null
          continue
        }
        if (line.startsWith(':')) continue

        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
          continue
        }

        if (!line.startsWith('data: ')) {
          log.warn(`${ts()} unexpected SSE line: ${line.slice(0, 200)}`)
          continue
        }

        const payload = line.slice(6)
        if (payload === '[DONE]') continue

        let data: SSEData
        try {
          data = JSON.parse(payload) as SSEData
        } catch (err) {
          log.warn(`${ts()} could not parse SSE payload (event=${currentEvent}): ${err instanceof Error ? err.message : err} | payload: ${payload.slice(0, 200)}`)
          continue
        }

        const eventType = data.type ?? currentEvent ?? ''
        eventCount += 1

        if (data.error) {
          throw new Error(`Hermes stream error: ${data.error.message ?? JSON.stringify(data.error)}`)
        }

        if (eventType === 'response.created') {
          log.info(`${ts()} response.created`)
          continue
        }

        if (eventType === 'response.output_item.added') {
          const item = data.item
          if (!item) continue
          const rawType = item.type
          if (rawType === 'message') {
            const itemId = item.id ?? `msg-${blockOrder.length}`
            messageStates.set(itemId, {
              itemId,
              chunkIdx: 0,
              currentBlockId: '',
              currentText: '',
              totalEmitted: 0,
            })
            log.info(`${ts()} item.added id=${itemId} kind=message (buffered)`)
            continue
          }
          const kind = classifyItemKind(rawType)
          if (!kind) {
            log.info(`${ts()} item.added skipped — unhandled type=${rawType}`)
            continue
          }
          const id = item.id ?? `block-${blockOrder.length}`
          const tool = kind === 'tool_call' ? (item.name ?? 'tool') : undefined
          registerBlock(id, kind)
          log.info(`${ts()} item.added id=${id} kind=${kind}${tool ? ` tool=${tool}` : ''}`)
          handlers.onBlockStart(id, kind, tool !== undefined ? { tool } : {})
          continue
        }

        if (eventType === 'response.output_text.delta') {
          const id = data.item_id
          const delta = typeof data.delta === 'string' ? data.delta : ''
          if (!id || !delta) continue
          const state = messageStates.get(id)
          if (!state) {
            log.warn(`${ts()} output_text.delta for unknown message item_id=${id}`)
            continue
          }
          if (firstContentAtMs === null) {
            firstContentAtMs = performance.now() - t0
            log.info(`${ts()} first content chunk`)
          }
          processMessageText(state, delta)
          continue
        }

        if (eventType === 'response.output_item.done') {
          const item = data.item
          if (!item?.id) continue
          const state = messageStates.get(item.id)
          if (state) {
            const finalText = extractItemFinalText(item, 'message') ?? ''
            if (finalText.length > state.totalEmitted) {
              const tail = finalText.slice(state.totalEmitted)
              processMessageText(state, tail)
            }
            closeCurrentChunk(state)
            messageStates.delete(item.id)
            log.info(`${ts()} item.done id=${item.id} kind=message (${finalText.length}ch total)`)
            continue
          }
          const rec = blocks.get(item.id)
          if (!rec) continue
          const finalText = extractItemFinalText(item, rec.kind) ?? rec.text
          rec.text = finalText
          log.info(`${ts()} item.done id=${item.id} kind=${rec.kind} (${finalText.length}ch) | ${truncatePreview(finalText, 1000)}`)
          handlers.onBlockEnd(item.id, finalText)
          continue
        }

        if (eventType === 'response.completed') {
          log.info(`${ts()} response.completed`)
          continue
        }

        if (!eventType.startsWith('response.')) {
          if (unhandledLogged < 3) {
            unhandledLogged += 1
            log.info(`${ts()} event=${eventType} data=${payload.slice(0, 160)}`)
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // If the stream ends before an item.done (network interruption, etc.), flush the last chunk
  // so accumulated text is still shown / spoken.
  for (const state of messageStates.values()) closeCurrentChunk(state)
  messageStates.clear()

  const messageParts: string[] = []
  for (const id of blockOrder) {
    const rec = blocks.get(id)
    if (rec?.kind === 'message' && rec.text.trim()) messageParts.push(rec.text)
  }
  const finalMessage = messageParts.join('\n\n')

  const totalMs = Math.round(performance.now() - t0)
  const firstContent = firstContentAtMs !== null ? `${Math.round(firstContentAtMs)}ms` : 'never'
  log.info(`${ts()} done | total=${totalMs}ms first-content=${firstContent} events=${eventCount} blocks=${blockOrder.length} → "${truncatePreview(finalMessage, 1000)}"`)

  return { finalMessage }
}

function classifyItemKind(type: string | undefined): BlockKind | null {
  switch (type) {
    case 'function_call':
      return 'tool_call'
    case 'function_call_output':
      return 'tool_output'
    case 'message':
      return 'message'
    default:
      return null
  }
}

function extractItemFinalText(item: ResponseItem, kind: BlockKind): string | null {
  if (kind === 'tool_call') return stringify(item.arguments)
  if (kind === 'tool_output') return stringify(item.output)
  if (kind === 'message') {
    const content = item.content
    if (Array.isArray(content)) {
      return content.map((c) => c.text ?? '').filter(Boolean).join('\n')
    }
  }
  return null
}

