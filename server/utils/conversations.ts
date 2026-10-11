import type { ConversationPage, ConversationSummary, ConversationThread } from '~/shared/types'

async function personaApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${config.PERSONA_API_URL}/conversations${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.PERSONA_API_KEY}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw createError({ statusCode: res.status, message: `conversation-api ${res.status}: ${text}` })
  }
  return (await res.json()) as T
}

/** Conversation threads, kept in conversation-api under butler's own key. */
export const conversationStore = {
  list: (before?: string) =>
    personaApi<ConversationPage>(before ? `?before=${encodeURIComponent(before)}` : ''),
  create: async () =>
    (await personaApi<{ conversation: ConversationSummary }>('', { method: 'POST', body: {} })).conversation,
  thread: (id: string) => personaApi<ConversationThread>(`/${encodeURIComponent(id)}/messages`),
  append: (id: string, role: 'user' | 'assistant', content: string) =>
    personaApi(`/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { role, content } }),
  remove: (id: string) => personaApi(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
