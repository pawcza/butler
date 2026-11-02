import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationPage, ConversationSummary, ConversationThread, StoredMessage } from '~/shared/types'
import { CONVERSATION_ID_PATTERN, truncatePreview } from '~/shared/text'
import { config } from './config'
import { createLog } from './log'

const log = createLog('conversations')

const PAGE_SIZE = 20
const TITLE_LENGTH = 60

/**
 * Conversation threads as one JSON file each. Writes go through a temp file and a rename,
 * so a crash can't leave a half-written thread, and each thread has its own queue so
 * concurrent appends can't lose a message.
 */
export function createConversationStore(dir: string) {
  const queues = new Map<string, Promise<unknown>>()

  function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(task)
    queues.set(id, run)
    void run.catch(() => {}).finally(() => {
      if (queues.get(id) === run) queues.delete(id)
    })
    return run
  }

  const fileFor = (id: string): string => join(dir, `${id}.json`)

  async function read(id: string): Promise<ConversationThread | null> {
    if (!CONVERSATION_ID_PATTERN.test(id)) return null
    try {
      return JSON.parse(await readFile(fileFor(id), 'utf-8')) as ConversationThread
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async function write(thread: ConversationThread): Promise<void> {
    await mkdir(dir, { recursive: true })
    const target = fileFor(thread.conversation.id)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, 'w')
      try {
        await handle.writeFile(JSON.stringify(thread))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, target)
    } catch (err) {
      await rm(temp, { force: true })
      throw err
    }
  }

  async function summaries(): Promise<ConversationSummary[]> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const threads = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => read(name.slice(0, -'.json'.length)).catch((err: unknown) => {
          log.warn(`skipping unreadable thread ${name}: ${err instanceof Error ? err.message : err}`)
          return null
        })),
    )
    return threads.flatMap((thread) => (thread ? [thread.conversation] : []))
  }

  return {
    async list(before?: string): Promise<ConversationPage> {
      const all = (await summaries())
        .filter((c) => !before || c.lastMessageAt < before)
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      return { items: all.slice(0, PAGE_SIZE), hasMore: all.length > PAGE_SIZE }
    },

    async create(): Promise<ConversationSummary> {
      const now = new Date().toISOString()
      const conversation: ConversationSummary = {
        id: randomUUID(),
        title: null,
        messageCount: 0,
        createdAt: now,
        lastMessageAt: now,
      }
      await enqueue(conversation.id, () => write({ conversation, items: [] }))
      return conversation
    },

    thread(id: string): Promise<ConversationThread | null> {
      return enqueue(id, () => read(id))
    },

    append(id: string, role: StoredMessage['role'], content: string): Promise<StoredMessage> {
      return enqueue(id, async () => {
        const thread = await read(id)
        if (!thread) throw new Error(`conversation ${id} does not exist`)
        const message: StoredMessage = { id: randomUUID(), role, content, createdAt: new Date().toISOString() }
        await write({
          conversation: {
            ...thread.conversation,
            title: thread.conversation.title ?? (role === 'user' ? truncatePreview(content, TITLE_LENGTH) : null),
            messageCount: thread.items.length + 1,
            lastMessageAt: message.createdAt,
          },
          items: [...thread.items, message],
        })
        return message
      })
    },

    /** Resolves to false when there was nothing to delete. */
    remove(id: string): Promise<boolean> {
      return enqueue(id, async () => {
        if (!(await read(id))) return false
        await rm(fileFor(id), { force: true })
        return true
      })
    },
  }
}

export const conversationStore = createConversationStore(join(config.DATA_DIR, 'conversations'))
