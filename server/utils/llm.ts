import { randomUUID } from 'node:crypto'
import type { BlockKind } from '~/shared/types'
import { truncatePreview } from '~/shared/text'
import { createLog } from './log'

const log = createLog('llm')

/** Roughly 6k tokens. Local models often run with small context windows. */
const MAX_HISTORY_CHARS = 24_000
const STALL_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TOOL_ITERATIONS = 8

export interface BlockHandlers {
  onBlockStart: (blockId: string, kind: BlockKind, meta: { tool?: string }) => void
  onBlockDelta: (blockId: string, text: string) => void
  onBlockEnd: (blockId: string, text: string) => void
  /**
   * Fires when a speakable chunk is ready: one paragraph of message text, delimited by `\n`.
   * The pipeline uses this to synthesize TTS as the model streams instead of waiting for the full turn.
   */
  onSpeakChunk: (text: string) => void
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** What the tool loop needs from a tool source. MCP is the only implementation today. */
export interface ToolProvider {
  definitions: () => ToolDefinition[]
  execute: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
}

export interface RespondOptions {
  baseUrl: string
  model: string
  apiKey?: string | undefined
  tools?: ToolProvider
  maxToolIterations?: number
  signal?: AbortSignal
  /** Give up if the server sends nothing for this long. Any byte counts, including keepalives. */
  stallTimeoutMs?: number
}

export class LlmAbortedError extends Error {
  constructor() {
    super('LLM request aborted')
    this.name = 'LlmAbortedError'
  }
}

/** One entry of `delta.tool_calls`. Everything but the fragments themselves is optional in the wild. */
export interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: unknown }
}

interface CompletionChunk {
  choices?: Array<{
    /** Streaming servers send `delta`; a server that ignored `stream: true` sends `message`. */
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] | null }
    message?: { content?: string | null; tool_calls?: ToolCallDelta[] | null }
    finish_reason?: string | null
  }>
  error?: { message?: string } | string
}

/**
 * Yields each `data:` payload of a server-sent event stream, stopping at `[DONE]`.
 * Comments are skipped, and so are named events: extensions some servers add to the
 * standard unnamed chunks.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void = () => {},
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''

  function* drain(lines: string[]): Generator<string> {
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) {
        eventName = ''
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:') && (!eventName || eventName === 'message')) {
        yield line.slice(5).trim()
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      onActivity()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const data of drain(lines)) {
        if (data === '[DONE]') return
        yield data
      }
    }
    for (const data of drain([buffer])) {
      if (data !== '[DONE]') yield data
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/**
 * Splits streamed message text on runs of `\n` into one block per paragraph, so each
 * paragraph can be shown and spoken as soon as it is complete.
 */
export function createParagraphChunker(messageId: string, handlers: BlockHandlers) {
  let index = 0
  let blockId = ''
  let current = ''
  const paragraphs: string[] = []

  function endBlock(): string {
    handlers.onBlockEnd(blockId, current)
    const trimmed = current.trim()
    if (trimmed) paragraphs.push(trimmed)
    blockId = ''
    current = ''
    return trimmed
  }

  function close(): void {
    if (!blockId) return
    const trimmed = endBlock()
    if (trimmed) handlers.onSpeakChunk(trimmed)
  }

  function append(part: string): void {
    if (!blockId) {
      // Whitespace between paragraphs must not open an empty bubble.
      if (!part.trim()) return
      index += 1
      blockId = `${messageId}.${index}`
      handlers.onBlockStart(blockId, 'message', {})
    }
    current += part
    handlers.onBlockDelta(blockId, part)
  }

  return {
    push(delta: string): void {
      delta.replace(/\r/g, '').split(/\n+/).forEach((part, i) => {
        if (i > 0) close()
        if (part) append(part)
      })
    },
    /** End of a message: the last paragraph had no trailing newline. */
    flush: close,
    /** The turn failed: end the open block so it stops streaming in the UI, but don't speak it. */
    abandon(): void {
      if (blockId) endBlock()
    },
    paragraphs,
  }
}

/**
 * Reassembles tool calls from stream deltas. Servers disagree on nearly everything here:
 * a call may be split across many chunks or arrive whole, `id` is only on the first
 * fragment, some omit `index` or reuse index 0 for every call, and some send arguments
 * as an object instead of a JSON string.
 */
export function createToolCallAccumulator() {
  interface Pending { id: string; name: string; args: string }
  const calls: Pending[] = []
  const byIndex = new Map<number, Pending>()

  return {
    add(deltas: ToolCallDelta[]): void {
      for (const delta of deltas) {
        let call = delta.index !== undefined ? byIndex.get(delta.index) : calls.at(-1)
        if (!call || (delta.id && call.id && delta.id !== call.id)) {
          call = { id: '', name: '', args: '' }
          calls.push(call)
          if (delta.index !== undefined) byIndex.set(delta.index, call)
        }
        if (delta.id) call.id = delta.id
        const name = delta.function?.name
        if (name && name !== call.name) call.name += name
        const args = delta.function?.arguments
        if (typeof args === 'string') call.args += args
        else if (args !== undefined && args !== null) call.args = JSON.stringify(args)
      }
    },
    finish(): ToolCall[] {
      return calls
        .filter((call) => call.name)
        .map((call) => ({
          id: call.id || `call_${randomUUID()}`,
          type: 'function' as const,
          function: { name: call.name, arguments: call.args },
        }))
    },
  }
}

interface Turn {
  text: string
  paragraphs: string[]
  toolCalls: ToolCall[]
}

function chunkError(chunk: CompletionChunk): string | null {
  if (!chunk.error) return null
  return typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error))
}

/** One model call: streams message text into blocks and collects any tool calls. */
async function streamTurn(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  handlers: BlockHandlers,
  options: RespondOptions,
): Promise<Turn> {
  if (options.signal?.aborted) throw new LlmAbortedError()

  const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS
  const controller = new AbortController()
  let stalled = false
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const onActivity = (): void => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, stallTimeoutMs)
  }
  const onOuterAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  const chunker = createParagraphChunker(`msg-${randomUUID().slice(0, 8)}`, handlers)
  const toolCalls = createToolCallAccumulator()
  let text = ''

  function apply(chunk: CompletionChunk): void {
    const error = chunkError(chunk)
    if (error) throw new Error(`LLM stream error: ${error}`)
    const choice = chunk.choices?.[0]
    const delta = choice?.delta ?? choice?.message
    if (delta?.content) {
      text += delta.content
      chunker.push(delta.content)
    }
    if (delta?.tool_calls) toolCalls.add(delta.tool_calls)
    if (choice?.finish_reason === 'error') throw new Error('LLM stream error: the server reported a failed turn')
  }

  try {
    onActivity()
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
      }),
      signal: controller.signal,
    })
    onActivity()

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)')
      throw new Error(`LLM ${response.status}: ${body.slice(0, 500)}`)
    }
    if (!response.body) throw new Error('LLM returned no body')

    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const data of readSse(response.body, onActivity)) {
        let chunk: CompletionChunk
        try {
          chunk = JSON.parse(data) as CompletionChunk
        } catch {
          log.warn(`skipping unparseable chunk: ${data.slice(0, 200)}`)
          continue
        }
        apply(chunk)
      }
    } else {
      apply((await response.json()) as CompletionChunk)
    }

    chunker.flush()
    return { text, paragraphs: chunker.paragraphs, toolCalls: toolCalls.finish() }
  } catch (err) {
    chunker.abandon()
    if (options.signal?.aborted) throw new LlmAbortedError()
    if (stalled) throw new Error(`LLM stalled: nothing received for ${Math.round(stallTimeoutMs / 1000)}s`)
    throw err
  } finally {
    clearTimeout(stallTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

async function runToolCall(
  call: ToolCall,
  tools: ToolProvider,
  handlers: BlockHandlers,
  signal: AbortSignal,
): Promise<string> {
  const { name, arguments: rawArgs } = call.function
  const blockId = `tool-${randomUUID().slice(0, 8)}`
  handlers.onBlockStart(`${blockId}.call`, 'tool_call', { tool: name })
  handlers.onBlockEnd(`${blockId}.call`, rawArgs)
  handlers.onBlockStart(`${blockId}.output`, 'tool_output', {})

  let output: string
  try {
    const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('tool arguments must be a JSON object')
    }
    output = await tools.execute(name, parsed as Record<string, unknown>, signal)
  } catch (err) {
    // The model gets the failure as the tool result, so it can recover or explain it.
    output = `Error: ${err instanceof Error ? err.message : String(err)}`
    log.warn(`tool ${name} failed: ${output}`)
  }

  handlers.onBlockEnd(`${blockId}.output`, output)
  return output
}

/**
 * Runs one assistant response: model, tool calls, execute, feed results back, model again.
 * Once the iteration cap is reached the model is called without tools, so it has to answer.
 */
export async function respond(
  messages: ChatMessage[],
  handlers: BlockHandlers,
  options: RespondOptions,
): Promise<{ finalMessage: string }> {
  const t0 = performance.now()
  const conversation = [...messages]
  const paragraphs: string[] = []
  const definitions = options.tools?.definitions() ?? []
  const maxIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
  const signal = options.signal ?? new AbortController().signal

  for (let iteration = 0; ; iteration++) {
    const tools = iteration < maxIterations ? definitions : []
    log.info(`POST ${options.baseUrl}/chat/completions model=${options.model} messages=${conversation.length} tools=${tools.length}`)
    const turn = await streamTurn(conversation, tools, handlers, options)
    paragraphs.push(...turn.paragraphs)

    if (tools.length === 0 || turn.toolCalls.length === 0 || !options.tools) break

    conversation.push({ role: 'assistant', content: turn.text, tool_calls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      const content = await runToolCall(call, options.tools, handlers, signal)
      if (signal.aborted) throw new LlmAbortedError()
      conversation.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }

  const finalMessage = paragraphs.join('\n\n')
  log.info(`done in ${Math.round(performance.now() - t0)}ms → "${truncatePreview(finalMessage, 200)}"`)
  return { finalMessage }
}

/**
 * Builds the request for a new user turn. Chat completions is stateless, so the history
 * goes along each time: as many recent turns as fit, always starting on a user message.
 * A failed turn leaves two user messages in a row, which strict servers reject, so
 * neighbours with the same role are merged.
 */
export function buildMessages(
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
  userText: string,
  systemPrompt?: string,
  maxChars: number = MAX_HISTORY_CHARS,
): ChatMessage[] {
  const recent: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: userText }]
  let used = userText.length
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]
    if (!item) continue
    used += item.content.length
    if (used > maxChars) break
    recent.unshift({ role: item.role, content: item.content })
  }
  while (recent[0]?.role === 'assistant') recent.shift()

  const merged: ChatMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : []
  for (const item of recent) {
    const last = merged.at(-1)
    if (last?.role === item.role) last.content += `\n\n${item.content}`
    else merged.push({ ...item })
  }
  return merged
}
