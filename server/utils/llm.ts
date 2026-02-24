import type { OllamaMessage, OllamaTool } from '~/shared/types'

const log = createLog('ollama')

interface OllamaResponse {
  message: OllamaMessage
  done: boolean
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
