import type { OllamaMessage, OllamaTool } from '~/shared/types'

const log = createLog('ollama')

interface OllamaResponse {
  message: OllamaMessage
  done: boolean
}

interface OllamaStreamChunk {
  message: { role: string; content: string }
  done: boolean
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

/** Strip any leaked <think>...</think> blocks from model output. */
export function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

export async function chatWithTools(
  messages: OllamaMessage[],
  tools: OllamaTool[] = [],
): Promise<OllamaMessage> {
  const body: Record<string, unknown> = {
    model: config.OLLAMA_MODEL,
    messages,
    stream: false,
    keep_alive: -1,
    think: false,
    ...(tools.length > 0 ? { tools } : {}),
    options: {
      num_ctx: 8192,
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  const t0 = performance.now()
  let response: Response
  try {
    response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Ollama request timed out after 60s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`Ollama ${response.status}: ${text}`)
  }

  const result = (await response.json()) as OllamaResponse & {
    prompt_eval_count?: number
    prompt_eval_duration?: number
    eval_count?: number
    eval_duration?: number
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
  const promptTokens = result.prompt_eval_count ?? '?'
  const promptMs = result.prompt_eval_duration ? (result.prompt_eval_duration / 1e6).toFixed(0) : '?'
  const genTokens = result.eval_count ?? '?'
  const genMs = result.eval_duration ? (result.eval_duration / 1e6).toFixed(0) : '?'
  // Strip any leaked thinking blocks
  result.message.content = stripThinking(result.message.content)
  const toolCallCount = result.message.tool_calls?.length ?? 0
  log.info(`${elapsed}s (prompt ${promptTokens}tok/${promptMs}ms, gen ${genTokens}tok/${genMs}ms) → ${toolCallCount > 0 ? `${toolCallCount} tool call(s)` : `"${result.message.content.slice(0, 120)}"`}`)
  return result.message
}

/**
 * Streaming variant — used ONLY for the final LLM response (no tools).
 * Calls onToken for each content token so the pipeline can emit response_delta events.
 * Returns the final assembled OllamaMessage.
 */
export async function chatStream(
  messages: OllamaMessage[],
  onToken: (token: string) => void,
): Promise<OllamaMessage> {
  const body: Record<string, unknown> = {
    model: config.OLLAMA_MODEL,
    messages,
    stream: true,
    keep_alive: -1,
    think: false,
    // No tools — this is the final text-only response
    options: {
      num_ctx: 8192,
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  const t0 = performance.now()
  let response: Response
  try {
    response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Ollama streaming request timed out after 60s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`Ollama ${response.status}: ${text}`)
  }

  if (!response.body) throw new Error('Ollama returned no body for streaming request')

  let fullContent = ''
  let promptTokens: number | string = '?'
  let promptMs = '?'
  let genTokens: number | string = '?'
  let genMs = '?'
  let inThinkBlock = false

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) continue

        let chunk: OllamaStreamChunk
        try {
          chunk = JSON.parse(line) as OllamaStreamChunk
        } catch {
          continue
        }

        const token = chunk.message.content
        if (token) {
          fullContent += token

          // Suppress <think>...</think> tokens
          if (token.includes('<think>')) inThinkBlock = true
          if (!inThinkBlock) onToken(token)
          if (token.includes('</think>')) inThinkBlock = false
        }

        if (chunk.done) {
          if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count
          if (chunk.prompt_eval_duration !== undefined) promptMs = (chunk.prompt_eval_duration / 1e6).toFixed(0)
          if (chunk.eval_count !== undefined) genTokens = chunk.eval_count
          if (chunk.eval_duration !== undefined) genMs = (chunk.eval_duration / 1e6).toFixed(0)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  fullContent = stripThinking(fullContent)
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
  log.info(`${elapsed}s stream (prompt ${promptTokens}tok/${promptMs}ms, gen ${genTokens}tok/${genMs}ms) → "${fullContent.slice(0, 120)}"`)

  return { role: 'assistant', content: fullContent }
}
