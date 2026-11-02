import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConversationStore } from '../server/utils/conversations'
import { matchWakeWord } from '../shared/text'

describe('conversation store', () => {
  let dir: string
  let store: ReturnType<typeof createConversationStore>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'butler-store-'))
    store = createConversationStore(join(dir, 'conversations'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('lists nothing before the first thread exists', async () => {
    expect(await store.list()).toEqual({ items: [], hasMore: false })
  })

  it('opens a thread and reopens it with its messages in order', async () => {
    const { id } = await store.create()
    await store.append(id, 'user', 'Hello there')
    await store.append(id, 'assistant', 'Good evening.')

    const reopened = await createConversationStore(join(dir, 'conversations')).thread(id)
    expect(reopened?.items.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hello there'],
      ['assistant', 'Good evening.'],
    ])
    expect(reopened?.conversation.messageCount).toBe(2)
  })

  it('titles a thread from its first user message', async () => {
    const { id } = await store.create()
    expect((await store.thread(id))?.conversation.title).toBeNull()
    await store.append(id, 'user', `A long  question ${'x'.repeat(100)}`)
    await store.append(id, 'user', 'A later one')
    const title = (await store.thread(id))?.conversation.title
    expect(title?.startsWith('A long question')).toBe(true)
    expect(title?.length).toBeLessThanOrEqual(61)
  })

  it('does not lose messages appended concurrently', async () => {
    const { id } = await store.create()
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.append(id, 'user', `m${i}`)))
    const thread = await store.thread(id)
    expect(thread?.items.map((m) => m.content)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`))
    expect(thread?.conversation.messageCount).toBe(25)
  })

  it('leaves no temp files behind', async () => {
    const { id } = await store.create()
    await store.append(id, 'user', 'hi')
    expect(await readdir(join(dir, 'conversations'))).toEqual([`${id}.json`])
  })

  it('keeps the last good thread if a write cannot complete', async () => {
    const { id } = await store.create()
    await store.append(id, 'user', 'kept')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(store.append(id, 'user', circular as unknown as string)).rejects.toThrow()
    expect((await store.thread(id))?.items.map((m) => m.content)).toEqual(['kept'])
    expect(await readdir(join(dir, 'conversations'))).toEqual([`${id}.json`])
  })

  it('lists newest first and pages with a cursor', async () => {
    const ids: string[] = []
    for (let i = 0; i < 23; i++) {
      const { id } = await store.create()
      await store.append(id, 'user', `thread ${i}`)
      ids.push(id)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const first = await store.list()
    expect(first.items).toHaveLength(20)
    expect(first.hasMore).toBe(true)
    expect(first.items[0]?.id).toBe(ids.at(-1))

    const second = await store.list(first.items.at(-1)?.lastMessageAt)
    expect(second.items).toHaveLength(3)
    expect(second.hasMore).toBe(false)
    expect(second.items.at(-1)?.id).toBe(ids[0])
  })

  it('deletes a thread, and reports when there was nothing to delete', async () => {
    const { id } = await store.create()
    expect(await store.remove(id)).toBe(true)
    expect(await store.thread(id)).toBeNull()
    expect(await store.remove(id)).toBe(false)
  })

  it('treats an unknown thread as missing, and refuses to append to it', async () => {
    expect(await store.thread('3f0f4a4e-unknown')).toBeNull()
    await expect(store.append('3f0f4a4e-unknown', 'user', 'x')).rejects.toThrow(/does not exist/)
  })

  it('never touches a path outside its directory', async () => {
    await writeFile(join(dir, 'secret.json'), '{"conversation":{"id":"secret"},"items":[]}')
    expect(await store.thread('../secret')).toBeNull()
    expect(await store.remove('../secret')).toBe(false)
    await expect(readFile(join(dir, 'secret.json'), 'utf-8')).resolves.toContain('secret')
  })

  it('skips a corrupt file instead of failing the whole list', async () => {
    const { id } = await store.create()
    await store.append(id, 'user', 'fine')
    await writeFile(join(dir, 'conversations', 'broken.json'), '{')
    expect((await store.list()).items.map((c) => c.id)).toEqual([id])
  })
})

describe('matchWakeWord', () => {
  it('returns the words after the wake word', () => {
    expect(matchWakeWord('Hey Butler, turn on the lights.', 'butler')).toBe('turn on the lights.')
  })

  it('is empty when the wake word is said alone, and null when it is not said', () => {
    expect(matchWakeWord('Butler.', 'butler')).toBe('')
    expect(matchWakeWord('good morning', 'butler')).toBeNull()
  })
})
