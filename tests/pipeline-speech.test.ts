import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../shared/types'
import { LiveTranscription } from '../server/utils/live-transcription'
import { startMockOpenAI, textFrames, type MockOpenAI } from './support/mock-openai'

const FIRST = 'The first paragraph has a first sentence. It also has a second sentence.'
const SECOND = 'The second paragraph begins here. It has more to say. And it ends with this sentence.'
const WHOLE = `${FIRST}\n\n${SECOND}`

let mock: MockOpenAI
let tts: Server
let dataDir: string
/** Requests the speech server got, with whether the client hung up on each. */
const speechRequests: Array<{ input: string; hungUp: boolean; respond: () => void }> = []
let pipeline: typeof import('../server/utils/pipeline')
let sessionModule: typeof import('../server/utils/session')
let store: typeof import('../server/utils/conversations').conversationStore

beforeAll(async () => {
  mock = await startMockOpenAI()
  dataDir = await mkdtemp(join(tmpdir(), 'butler-pipeline-'))
  tts = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const entry = {
        input: (JSON.parse(Buffer.concat(chunks).toString()) as { input: string }).input,
        hungUp: false,
        respond: () => { if (res.headersSent || res.destroyed) return; res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('clip')) },
      }
      res.on('close', () => { if (!res.writableEnded) entry.hungUp = true })
      speechRequests.push(entry)
    })
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

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('processCommand speech', () => {
  it('stops speaking mid-reply: no audio after the stop, the rest is never synthesized, the text is stored, the turn ends IDLE', async () => {
    speechRequests.length = 0
    mock.enqueue({ frames: textFrames(`${FIRST}\n`, `${SECOND}`) })
    const events: ServerEvent[] = []
    const states: string[] = []
    const session = new sessionModule.SessionManager((state) => states.push(state))
    const turn = pipeline.processCommand('say something long', session, (event) => events.push(event))

    // the first sentence goes out; two more requests are in flight behind it
    await until(() => speechRequests.length >= 2)
    // the two requests can arrive in either order: answer the one that reads the first sentence
    const first = speechRequests.find((r) => r.input.startsWith('The first paragraph'))
    first?.respond()
    await until(() => events.some((e) => e.type === 'audio'))
    await until(() => speechRequests.length === 3)
    expect(states).toContain('SPEAKING')

    session.stopSpeech()
    const audioBefore = events.filter((e) => e.type === 'audio').length
    // the speech server was hung up on, so it never gets to answer
    await turn

    expect(events.filter((e) => e.type === 'audio')).toHaveLength(audioBefore)
    expect(audioBefore).toBe(1)
    // 2 and 3 were hung up on; the fourth was never requested
    expect(speechRequests).toHaveLength(3)
    await until(() => speechRequests.filter((r) => r !== first).every((r) => r.hungUp))
    expect(states.at(-1)).toBe('IDLE')
    expect(session.getState()).toBe('IDLE')

    // the reply text still streamed and was stored in full
    const end = events.find((e) => e.type === 'response_end')
    expect(end).toEqual({ type: 'response_end', text: WHOLE })
    const ended = events.filter((e) => e.type === 'block_end')
    expect(ended.map((e) => (e.type === 'block_end' ? e.text : ''))).toEqual([FIRST, SECOND])
    const conversation = events.find((e) => e.type === 'conversation')
    const thread = await store.thread(conversation?.type === 'conversation' ? conversation.conversation.id : '')
    expect(thread?.items.map((m) => [m.role, m.content])).toEqual([['user', 'say something long'], ['assistant', WHOLE]])
  })

  it('speaks in order, one audio event per sentence with its block and range, and ends IDLE', async () => {
    speechRequests.length = 0
    mock.enqueue({ frames: textFrames(`${FIRST}\n`, `${SECOND}`) })
    const events: ServerEvent[] = []
    const session = new sessionModule.SessionManager(() => {})
    const turn = pipeline.processCommand('and again', session, (event) => events.push(event))
    // answer every request, last first
    await until(() => speechRequests.length >= 2)
    for (let answered = 0; answered < 4;) {
      await until(() => speechRequests.length > answered)
      speechRequests[answered]?.respond()
      answered += 1
    }
    await turn

    const clips = events.filter((e) => e.type === 'audio')
    expect(clips).toHaveLength(4)
    const blocks = events.filter((e) => e.type === 'block_start' && e.kind === 'message').map((e) => (e.type === 'block_start' ? e.blockId : ''))
    const spoken = clips.map((e) => (e.type === 'audio' && e.block ? WHOLE.split('\n\n')[blocks.indexOf(e.block.id)]?.slice(e.block.start, e.block.end) : ''))
    expect(spoken).toEqual([
      'The first paragraph has a first sentence.',
      'It also has a second sentence.',
      'The second paragraph begins here.',
      'It has more to say. And it ends with this sentence.',
    ])
    expect(session.getState()).toBe('IDLE')
  })

  it('barge-in: with only speech left, a capture may open and the old turn cannot idle the session', async () => {
    speechRequests.length = 0
    mock.enqueue({ frames: textFrames(FIRST) })
    const session = new sessionModule.SessionManager(() => {})
    const turn = pipeline.processCommand('talk to me', session, () => {})
    await until(() => speechRequests.length >= 1)
    await until(() => session.canCapture())
    expect(session.getState()).toBe('SPEAKING')

    session.supersedeTurn()
    session.setState('LISTENING')
    for (const request of speechRequests) request.respond()
    await turn
    expect(session.getState()).toBe('LISTENING')
  })
})

describe('a closed socket never runs a turn', () => {
  it('closing during the final transcription pass aborts it: no LLM call, no stored turn, no events', async () => {
    const before = mock.requests.length
    let signal: AbortSignal | null = null
    const live = new LiveTranscription({
      transcribe: (_pcm, s) => new Promise<string>((_resolve, reject) => {
        signal = s
        s.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
      onPartial: () => {},
    })
    live.push(new Int16Array(16000))
    const events: ServerEvent[] = []
    const session = new sessionModule.SessionManager(() => {})
    const threads = vi.spyOn(store, 'create')
    // endCapture has already taken the capture out of its map: only the session can reach it now
    const done = pipeline.processCapture({ id: 'user-1', live }, session, (event) => events.push(event))
    await until(() => signal !== null)
    session.close()
    await done

    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    expect(mock.requests).toHaveLength(before)
    expect(threads).not.toHaveBeenCalled()
    expect(events).toEqual([])
    threads.mockRestore()
  })

  it('a final transcript that arrives after the close is not answered', async () => {
    const before = mock.requests.length
    const live = new LiveTranscription({ transcribe: async () => 'turn the lights off', onPartial: () => {} })
    live.push(new Int16Array(16000))
    const events: ServerEvent[] = []
    const session = new sessionModule.SessionManager(() => {})
    const finish = live.finish.bind(live)
    live.finish = async () => { const text = await finish(); session.close(); return text }
    await pipeline.processCapture({ id: 'user-2', live }, session, (event) => events.push(event))
    expect(mock.requests).toHaveLength(before)
    expect(events).toEqual([])
  })

  it('closing during the conversation-store await of a typed command: no LLM call, nothing stored', async () => {
    const before = mock.requests.length
    const session = new sessionModule.SessionManager(() => {})
    session.setConversationId('6f1c2a7e-3b0d-4c8e-9a51-2d4f7b8e0c13')
    const lookup = vi.spyOn(store, 'thread').mockImplementation(async () => { session.close(); return null })
    const create = vi.spyOn(store, 'create')
    const append = vi.spyOn(store, 'append')
    const events: ServerEvent[] = []
    await pipeline.processCommand('turn the lights off', session, (event) => events.push(event))
    lookup.mockRestore()
    expect(mock.requests).toHaveLength(before)
    expect(create).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(events).toEqual([])
    create.mockRestore()
    append.mockRestore()
  })

  it('a session that is already closed answers nothing', async () => {
    const before = mock.requests.length
    const session = new sessionModule.SessionManager(() => {})
    session.close()
    await pipeline.processCommand('hello there', session, () => {})
    expect(mock.requests).toHaveLength(before)
  })
})
