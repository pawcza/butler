import type { OllamaMessage, OllamaToolCall, ServerEvent } from '~/shared/types'

const log = createLog('pipeline')

// Common Whisper hallucinations when transcribing silence or background noise.
const WHISPER_HALLUCINATION_PATTERNS: RegExp[] = [
  /^thank(s| you)/i,
  /^you'?re welcome/i,
  /^(please )?(like|subscribe|comment)/i,
  /^(i'?ll )?see you (in |next )/i,
  /^(bye|goodbye|good night)/i,
  /^thanks for (watching|listening|viewing)/i,
  /^(please )?don'?t forget to/i,
  /^(so|okay|well|right|alright|um|uh)[.!,]?$/i,
  /^\.+$/,
  /^\[.*\]$/,
  /^(music|applause|laughter)$/i,
  /^you$/i,
  /^oh$/i,
  /^hmm?$/i,
  /^subs by/i,
  /^translated by/i,
  /^subtitles by/i,
  /^copyright/i,
]

function isWhisperHallucination(text: string): boolean {
  const cleaned = text.replace(/[.!?,;:]+$/, '').trim()
  return WHISPER_HALLUCINATION_PATTERNS.some((p) => p.test(cleaned))
}

// ── Text-based tool call extraction (fallback for models without native tool calling) ──

/**
 * Walk a string to find the outermost JSON object or array,
 * correctly handling nested braces/brackets and string literals.
 */
function extractJson(text: string): string | null {
  let start = -1
  let openChar: '{' | '[' | null = null
  let closeChar: '}' | ']' | null = null

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      start = i
      openChar = ch
      closeChar = ch === '{' ? '}' : ']'
      break
    }
  }

  if (start === -1 || openChar === null || closeChar === null) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === openChar) depth++
    else if (ch === closeChar) {
      depth--
      if (depth === 0) return text.substring(start, i + 1)
    }
  }

  return null
}

function isKnownTool(name: string): boolean {
  return isBuiltInTool(name) || isHaTool(name)
}

/**
 * Fallback: extract tool calls from text content when the model outputs
 * JSON instead of using native tool_calls (common with qwen2.5 and smaller models).
 *
 * Handles:
 * - {"name": "x", "arguments": {...}}  (Ollama text format)
 * - [{"tool": "x", ...params}]          (old butler format)
 */
function extractToolCallsFromText(text: string): OllamaToolCall[] {
  const jsonStr = extractJson(text)
  if (!jsonStr) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return []
  }

  const items = Array.isArray(parsed) ? parsed : [parsed]
  const calls: OllamaToolCall[] = []

  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>

    // Format 1: {"name": "tool_name", "arguments": {...}}
    if (typeof obj['name'] === 'string' && typeof obj['arguments'] === 'object' && obj['arguments'] !== null) {
      const name = obj['name'] as string
      if (isKnownTool(name)) {
        calls.push({ function: { name, arguments: obj['arguments'] as Record<string, unknown> } })
      }
      continue
    }

    // Format 2: {"tool": "tool_name", ...params}
    if (typeof obj['tool'] === 'string') {
      const name = obj['tool'] as string
      if (isKnownTool(name)) {
        const { tool: _, ...args } = obj
        calls.push({ function: { name, arguments: args } })
      }
      continue
    }
  }

  return calls
}

/**
 * Get tool_calls from an assistant message — either native or extracted from text.
 * If calls were extracted from text, the content is stripped since it's just wrapper prose.
 */
function resolveToolCalls(msg: OllamaMessage): { toolCalls: OllamaToolCall[]; content: string } {
  // Prefer native tool_calls
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return { toolCalls: msg.tool_calls, content: msg.content }
  }

  // Fallback: extract from text content
  if (msg.content) {
    const extracted = extractToolCallsFromText(msg.content)
    if (extracted.length > 0) {
      log.warn(`fallback: extracted ${extracted.length} tool call(s) from text`)
      return { toolCalls: extracted, content: '' }
    }
  }

  return { toolCalls: [], content: msg.content }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

type Emitter = (event: ServerEvent) => void

async function speakAndEmit(text: string, session: SessionManager, emit: Emitter): Promise<void> {
  session.setState('SPEAKING')
  try {
    const ttsModel = session.getTtsModel()
    const ttsVoice = session.getTtsVoice()
    const ttsOpts: TtsOptions = {
      ...(ttsModel !== null ? { model: ttsModel } : {}),
      ...(ttsVoice !== null ? { voice: ttsVoice } : {}),
    }
    const audioBuffer = await synthesize(text, ttsOpts)
    emit({ type: 'audio', data: audioBuffer.toString('base64'), format: config.PIPER_RESPONSE_FORMAT })
  } catch (err) {
    emit({ type: 'error', message: `TTS failed: ${err instanceof Error ? err.message : err}` })
  }
}

export async function processAudio(
  audioBuffer: Buffer,
  session: SessionManager,
  emit: Emitter,
  peerId: string,
): Promise<void> {
  const t0 = Date.now()
  session.setState('LISTENING')

  let transcript: string
  try {
    transcript = await transcribe(audioBuffer)
  } catch (err) {
    emit({ type: 'error', message: `STT failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }
  const sttMs = Date.now() - t0
  log.info(`STT: ${sttMs}ms → "${transcript.trim()}"`)


  const trimmed = transcript.trim()
  emit({ type: 'transcript', text: trimmed })

  if (trimmed.length < 2 || trimmed.split(/\s+/).length < 2) {
    log.warn(`discarding noise transcript: "${trimmed}" (${sttMs}ms wasted)`)
    session.setState('IDLE')
    return
  }

  if (isWhisperHallucination(trimmed)) {
    log.warn(`discarding hallucinated transcript: "${trimmed}" (${sttMs}ms wasted)`)
    session.setState('IDLE')
    return
  }

  await processCommand(transcript, session, emit, peerId, t0)
}

export async function processCommand(
  text: string,
  session: SessionManager,
  emit: Emitter,
  peerId: string,
  startedAt?: number,
): Promise<void> {
  const t0 = startedAt ?? Date.now()
  const lap = () => Date.now() - t0
  session.setState('THINKING')

  const systemPrompt = buildSystemPrompt(session.getPersonality())
  const history: OllamaMessage[] = session.getHistory().map((m) => ({
    role: m.role,
    content: m.content,
  }))
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: text },
  ]

  const tools = getOllamaTools()
  log.info(`▶ "${text}"`)
  log.info(`  system: ${systemPrompt.length}ch | tools: ${tools.length}`)


  const MAX_TOOL_ROUNDS = 3

  // Phase 1: Initial LLM call (non-streaming, with tools — reliable tool detection)
  let assistantMsg: OllamaMessage
  try {
    assistantMsg = await chatWithTools(messages, tools)
  } catch (err) {
    emit({ type: 'error', message: `LLM failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }

  let resolved = resolveToolCalls(assistantMsg)
  log.info(`+${lap()}ms LLM done`)

  // Phase 2: Tool execution loop
  let round = 0
  let totalToolCalls = 0
  let streamedFinalResponse = false

  while (resolved.toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
    round++
    session.setState('EXECUTING')

    messages.push({ ...assistantMsg, tool_calls: resolved.toolCalls, content: resolved.content })

    const toolResults = await Promise.all(
      resolved.toolCalls.map(async (tc) => {
        const name = tc.function.name
        const args = tc.function.arguments
        const t = Date.now()
        let result: string
        let status = 'OK'
        try {
          if (isBuiltInTool(name)) {
            result = await executeBuiltIn(name, args, { emit, peerId })
          } else {
            result = await executeHaTool(name, args)
          }
          if (result.startsWith('Error')) status = 'err'
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : err}`
          status = 'err'
        }
        return { name, args, result, status, ms: Date.now() - t }
      }),
    )

    totalToolCalls += toolResults.length
    log.table(toolResults.map((r) => ({
      tool: r.name,
      args: JSON.stringify(r.args).slice(0, 40),
      status: r.status,
      time: `${r.ms}ms`,
    })))

    for (const r of toolResults) {
      messages.push({ role: 'tool', content: r.result, tool_name: r.name })
    }
    log.divider()

    // Follow-up: stream the interpretation (no tools — pure text)
    session.setState('THINKING')
    try {
      emit({ type: 'response_start' })
      assistantMsg = await chatStream(messages, (token) => {
        emit({ type: 'response_delta', text: token })
      })
    } catch (err) {
      emit({ type: 'response_end', text: '' })
      emit({ type: 'error', message: `LLM failed: ${err instanceof Error ? err.message : err}` })
      session.setState('IDLE')
      return
    }

    resolved = resolveToolCalls(assistantMsg)
    log.info(`+${lap()}ms follow-up done (round ${round})`)

    if (resolved.toolCalls.length > 0) {
      // More tool calls — signal client to discard streamed text
      emit({ type: 'response_end', text: '' })
    } else {
      // Final response — close the stream
      const text = assistantMsg.content.trim()
      emit({ type: 'response_end', text })
      streamedFinalResponse = true
    }
  }

  if (round >= MAX_TOOL_ROUNDS && resolved.toolCalls.length > 0) {
    log.warn(`max tool rounds (${MAX_TOOL_ROUNDS}) reached, returning last response`)
  }

  const replyText = (round > 0 ? assistantMsg.content : resolved.content).trim() || 'Done. You are welcome.'

  // Phase 3: Emit streaming events for the no-tool path (text already computed)
  if (!streamedFinalResponse) {
    emit({ type: 'response_start' })
    emit({ type: 'response_delta', text: replyText })
    emit({ type: 'response_end', text: replyText })
  }

  session.addMessage({ role: 'user', content: text })
  session.addMessage({ role: 'assistant', content: replyText })

  emit({ type: 'response', text: replyText })

  const ttsStart = Date.now()
  await speakAndEmit(replyText, session, emit)
  const ttsMs = Date.now() - ttsStart

  log.divider()
  log.table({
    total: `${lap()}ms`,
    rounds: round,
    tools: totalToolCalls,
    tts: `${ttsMs}ms`,
  })
  session.setState('IDLE')
}
