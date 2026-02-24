import type { OllamaMessage, OllamaToolCall, ServerEvent } from '~/shared/types'

const MAX_TOOL_ROUNDS = 5

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
  return isBuiltInTool(name) || isMcpTool(name)
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
      console.log(`[pipeline] fallback: extracted ${extracted.length} tool call(s) from text`)
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
    const audioBuffer = await synthesize(text)
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
  session.setState('LISTENING')

  let transcript: string
  try {
    transcript = await transcribe(audioBuffer)
  } catch (err) {
    emit({ type: 'error', message: `STT failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }

  const trimmed = transcript.trim()
  emit({ type: 'transcript', text: trimmed })

  if (trimmed.length < 2 || trimmed.split(/\s+/).length < 2) {
    console.log(`[pipeline] discarding noise transcript: "${trimmed}"`)
    session.setState('IDLE')
    return
  }

  if (isWhisperHallucination(trimmed)) {
    console.log(`[pipeline] discarding hallucinated transcript: "${trimmed}"`)
    session.setState('IDLE')
    return
  }

  await processCommand(transcript, session, emit, peerId)
}

export async function processCommand(
  text: string,
  session: SessionManager,
  emit: Emitter,
  peerId: string,
): Promise<void> {
  session.setState('THINKING')

  const systemPrompt = buildSystemPrompt()
  const history = session.getHistory().slice(-6)

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m): OllamaMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ]

  const tools = getOllamaTools()
  console.log(`[pipeline] tools available: ${tools.length} (${tools.map((t) => t.function.name).join(', ')})`)

  let assistantMsg: OllamaMessage
  try {
    assistantMsg = await chatWithTools(messages, tools)
  } catch (err) {
    emit({ type: 'error', message: `LLM failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }

  // Resolve tool calls (native or text-extracted fallback)
  let { toolCalls, content } = resolveToolCalls(assistantMsg)
  console.log(`[llm] response: content=${JSON.stringify(content).slice(0, 200)}, tool_calls=${toolCalls.length}`)

  // Agentic loop: execute tool calls, feed results back, repeat
  let rounds = 0
  while (toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    rounds++
    session.setState('EXECUTING')

    // Add assistant message to conversation (with tool_calls for context)
    messages.push({ ...assistantMsg, tool_calls: toolCalls, content })

    for (const toolCall of toolCalls) {
      const name = toolCall.function.name
      const args = toolCall.function.arguments
      console.log(`[pipeline] tool call #${rounds}: ${name}(${JSON.stringify(args)})`)

      let result: string
      if (isBuiltInTool(name)) {
        result = await executeBuiltIn(name, args, { emit, peerId })
      } else {
        result = await executeMcpTool(name, args)
      }

      messages.push({ role: 'tool', content: result, tool_name: name })
    }

    // Ask LLM to interpret results (no tools — force text response)
    session.setState('THINKING')
    try {
      assistantMsg = await chatWithTools(messages, [])
    } catch (err) {
      emit({ type: 'error', message: `LLM failed: ${err instanceof Error ? err.message : err}` })
      session.setState('IDLE')
      return
    }

    const resolved = resolveToolCalls(assistantMsg)
    toolCalls = resolved.toolCalls
    content = resolved.content
    console.log(`[llm] follow-up #${rounds}: content=${JSON.stringify(content).slice(0, 200)}, tool_calls=${toolCalls.length}`)
  }

  const replyText = content.trim() || 'Done. You are welcome.'

  session.addMessage({ role: 'user', content: text })
  session.addMessage({ role: 'assistant', content: replyText })

  emit({ type: 'response', text: replyText })
  await speakAndEmit(replyText, session, emit)
  session.setState('IDLE')
}
