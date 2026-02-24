import type { OllamaMessage, OllamaTool } from '~/shared/types'

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
  tools: OllamaTool[],
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

  const payloadSize = JSON.stringify(body).length
  console.log(`[ollama] POST /api/chat — ${messages.length} messages, ${tools.length} tools, payload ${(payloadSize / 1024).toFixed(1)}KB`)

  const t0 = performance.now()
  const response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

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
  console.log(`[ollama] ${elapsed}s total | prompt: ${promptTokens} tokens/${promptMs}ms | gen: ${genTokens} tokens/${genMs}ms`)
  // Strip any leaked thinking blocks
  result.message.content = stripThinking(result.message.content)
  console.log(`[ollama] response — role=${result.message.role}, content=${result.message.content.length}ch, tool_calls=${result.message.tool_calls?.length ?? 0}`)
  return result.message
}
