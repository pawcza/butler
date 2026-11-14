import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../shared/types'
import { startMockOpenAI, textFrames, type MockOpenAI } from './support/mock-openai'

const REPLY = 'The first sentence is here. The second sentence follows it. The third sentence ends it. And a fourth one too.'

let mock: MockOpenAI
let tts: Server
let dataDir: string
let attempts = 0
/** What the speech server does with a request: hang up without an answer, or fail with a 500. */
let behaviour: 'hang-up' | 'error' = 'hang-up'
let pipeline: typeof import('../server/utils/pipeline')
let sessionModule: typeof import('../server/utils/session')
let store: typeof import('../server/utils/conversations').conversationStore

beforeAll(async () => {
  mock = await startMockOpenAI()
  dataDir = await mkdtemp(join(tmpdir(), 'butler-tts-down-'))
  tts = createServer((req, res) => {
    attempts += 1
    req.resume()
    if (behaviour === 'hang-up') req.socket.destroy()
    else { res.writeHead(500); res.end('model failed') }
  })
  await new Promise<void>((resolve) => tts.listen(0, '127.0.0.1', resolve))
  process.env['LLM_BASE_URL'] = mock.url
  process.env['TTS_BASE_URL'] = `http://127.0.0.1:${(tts.address() as AddressInfo).port}/v1`
  process.env['DATA_DIR'] = dataDir
  pipeline = await import('../server/utils/pipeline')
  sessionModule = await import('../server/utils/session')
  store = (await import('../server/utils/conversations')).conversationStore
})

afterAll(async () => {
  tts.closeAllConnections()
  await new Promise<void>((resolve) => tts.close(() => resolve()))
  await mock.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function runTurn(text: string): Promise<{ events: ServerEvent[]; states: string[] }> {
  mock.enqueue({ frames: textFrames(REPLY) })
  const events: ServerEvent[] = []
  const states: string[] = []
  const session = new sessionModule.SessionManager((state) => states.push(state))
  await pipeline.processCommand(text, session, (event) => events.push(event))
  expect(session.getState()).toBe('IDLE')
  return { events, states }
}

describe('a speech engine that is down', () => {
  it('is tried once: one error, the reply still completes and is stored, and the next turn tries again', async () => {
    behaviour = 'hang-up'
    attempts = 0
    const { events } = await runTurn('tell me something')
    // concurrency is two, so at most the two sentences already in flight were attempted: never all four
    expect(attempts).toBeLessThanOrEqual(2)
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: expect.stringMatching(/^TTS failed: TTS unreachable/) })
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(0)
    expect(events.find((e) => e.type === 'response_end')).toEqual({ type: 'response_end', text: REPLY })
    const conversation = events.find((e) => e.type === 'conversation')
    const thread = await store.thread(conversation?.type === 'conversation' ? conversation.conversation.id : '')
    expect(thread?.items.at(-1)?.content).toBe(REPLY)

    const before = attempts
    const next = await runTurn('and again')
    expect(attempts).toBeGreaterThan(before)
    expect(next.events.filter((e) => e.type === 'error')).toHaveLength(1)
  })

  it('gives up after two failures of any other kind', async () => {
    behaviour = 'error'
    attempts = 0
    const { events } = await runTurn('tell me more')
    expect(attempts).toBe(2)
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toEqual([{ type: 'error', message: 'TTS failed: TTS 500: model failed' }])
  })
})
