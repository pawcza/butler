import type { Message } from '~/shared/types'

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaResponse {
  message: OllamaMessage
  done: boolean
}

export async function chat(
  transcript: string,
  history: Message[],
  systemPrompt: string,
): Promise<string> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: transcript },
  ]

  const response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.OLLAMA_MODEL, messages, stream: false }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)')
    throw new Error(`Ollama ${response.status}: ${text}`)
  }

  const result = (await response.json()) as OllamaResponse
  return result.message.content.trim()
}
