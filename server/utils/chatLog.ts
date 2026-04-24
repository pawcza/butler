import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockKind, ServerEvent } from '~/shared/types'

const log = createLog('chatLog')

/** Mirror of the client-side LogItem shape — kept in sync via recordEvent. */
export interface LogItem {
  id: string
  kind: 'user' | BlockKind
  tool?: string
  text: string
  streaming: boolean
}

const MAX_ITEMS = 200
const PERSIST_DEBOUNCE_MS = 400

let items: LogItem[] = load()
const byId = new Map<string, LogItem>(items.map((i) => [i.id, i]))
let persistTimer: ReturnType<typeof setTimeout> | null = null

function filePath(): string {
  return join(config.DATA_DIR, 'chat-log.json')
}

function load(): LogItem[] {
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as LogItem[]
    // Any item stuck in `streaming: true` at last save got interrupted — clear the flag.
    return parsed.map((item) => ({ ...item, streaming: false }))
  } catch {
    return []
  }
}

function persistSoon(): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      mkdirSync(config.DATA_DIR, { recursive: true })
      writeFileSync(filePath(), JSON.stringify(items), { encoding: 'utf-8' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`persist failed: ${msg}`)
    }
  }, PERSIST_DEBOUNCE_MS)
}

function push(item: LogItem): void {
  items.push(item)
  byId.set(item.id, item)
  if (items.length > MAX_ITEMS) {
    const dropped = items.splice(0, items.length - MAX_ITEMS)
    for (const d of dropped) byId.delete(d.id)
  }
  persistSoon()
}

/** Feed a server event (the same ones emitted to the client) into the persistent log. */
export function recordEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'transcript':
      push({
        id: event.id,
        kind: 'user',
        text: event.text,
        streaming: false,
      })
      return
    case 'block_start': {
      const item: LogItem = {
        id: event.blockId,
        kind: event.kind,
        text: '',
        streaming: true,
      }
      if (event.tool !== undefined) item.tool = event.tool
      push(item)
      return
    }
    case 'block_delta': {
      const item = byId.get(event.blockId)
      if (item) {
        item.text += event.text
        persistSoon()
      }
      return
    }
    case 'block_end': {
      const item = byId.get(event.blockId)
      if (item) {
        item.text = event.text
        item.streaming = false
        persistSoon()
      }
      return
    }
    default:
      // state / audio / response / response_* / error / pong — not persisted
  }
}

export function getLog(): readonly LogItem[] {
  return items
}
