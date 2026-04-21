import type { HermesMessage } from '~/shared/types'

const log = createLog('hermes')

interface ChatCompletionChunk {
  choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
}

/**
 * Stream a Hermes (OpenAI-compatible) chat completion.
 * Calls onToken for each content token; returns the accumulated full text.
 */
export async function chatStream(
  messages: HermesMessage[],
  onToken: (token: string) => void,
): Promise<string> {
  const toolsets = config.HERMES_TOOLSETS
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  const body: Record<string, unknown> = {
    model: config.HERMES_MODEL,
    messages,
    stream: true,
    // Hermes-specific hint: activates named toolsets (homeassistant, web, …) so the agent
    // exposes those tools to the model. Ignored by strict OpenAI-compatible servers.
    ...(toolsets.length > 0 ? { toolsets } : {}),
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  const t0 = performance.now()
  let response: Response
  try {
    response = await fetch(`${config.HERMES_API_URL}/chat/completions`, {
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
      throw new Error('Hermes request timed out after 60s')
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

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line || !line.startsWith('data: ')) continue

        const payload = line.slice(6)
        if (payload === '[DONE]') continue

        let chunk: ChatCompletionChunk & { error?: { message?: string } }
        try {
          chunk = JSON.parse(payload) as typeof chunk
        } catch (err) {
          log.warn(`could not parse SSE payload: ${err instanceof Error ? err.message : err} | payload: ${payload.slice(0, 200)}`)
          continue
        }

        if (chunk.error) {
          throw new Error(`Hermes stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`)
        }

        const token = chunk.choices?.[0]?.delta?.content
        if (token) {
          full += token
          onToken(token)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
  log.info(`${elapsed}s stream → "${full.slice(0, 120)}"`)
  return full
}
