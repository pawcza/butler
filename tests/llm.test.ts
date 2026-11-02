import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LlmAbortedError,
  buildMessages,
  createParagraphChunker,
  createToolCallAccumulator,
  readSse,
  respond,
  type BlockHandlers,
  type RespondOptions,
} from '../server/utils/llm'
import { chunk, startMockOpenAI, textFrames, type MockOpenAI } from './support/mock-openai'

function recorder() {
  const events: string[] = []
  const handlers: BlockHandlers = {
    onBlockStart: (id, kind, meta) => { events.push(`start ${id} ${kind}${meta.tool ? ` ${meta.tool}` : ''}`) },
    onBlockDelta: (id, text) => { events.push(`delta ${id} ${text}`) },
    onBlockEnd: (id, text) => { events.push(`end ${id} ${text}`) },
    onSpeakChunk: (text) => { events.push(`speak ${text}`) },
  }
  return { events, handlers, spoken: () => events.filter((e) => e.startsWith('speak ')).map((e) => e.slice(6)) }
}

function byteStream(...parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part)
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const items: string[] = []
  for await (const item of stream) items.push(item)
  return items
}

describe('readSse', () => {
  it('reassembles frames split at arbitrary byte boundaries, including inside a character', async () => {
    const bytes = new TextEncoder().encode('data: {"a":"zażółć"}\n\ndata: [DONE]\n\n')
    const parts = Array.from(bytes, (byte) => Uint8Array.of(byte))
    expect(await collect(readSse(byteStream(...parts)))).toEqual(['{"a":"zażółć"}'])
  })

  it('handles CRLF, a missing space after the colon, and a last line with no newline', async () => {
    expect(await collect(readSse(byteStream('data:one\r\n\r\ndata: two')))).toEqual(['one', 'two'])
  })

  it('skips comments and keepalives', async () => {
    expect(await collect(readSse(byteStream(': keepalive\n\ndata: one\n\n')))).toEqual(['one'])
  })

  it('skips named events but keeps the unnamed frames around them', async () => {
    const stream = byteStream('data: one\n\nevent: vendor.progress\ndata: {"tool":"x"}\n\ndata: two\n\n')
    expect(await collect(readSse(stream))).toEqual(['one', 'two'])
  })

  it('stops at [DONE]', async () => {
    expect(await collect(readSse(byteStream('data: one\n\ndata: [DONE]\n\ndata: late\n\n')))).toEqual(['one'])
  })
})

describe('createParagraphChunker', () => {
  it('opens one block per paragraph and speaks each as soon as its newline arrives', () => {
    const { events, handlers } = recorder()
    const chunker = createParagraphChunker('m', handlers)
    chunker.push('First ')
    chunker.push('line.\n\nSec')
    expect(events.at(-1)).toBe('delta m.2 Sec')
    expect(events).toContain('speak First line.')
    chunker.push('ond.')
    expect(events).not.toContain('speak Second.')
    chunker.flush()
    expect(events).toEqual([
      'start m.1 message',
      'delta m.1 First ',
      'delta m.1 line.',
      'end m.1 First line.',
      'speak First line.',
      'start m.2 message',
      'delta m.2 Sec',
      'delta m.2 ond.',
      'end m.2 Second.',
      'speak Second.',
    ])
    expect(chunker.paragraphs).toEqual(['First line.', 'Second.'])
  })

  it('treats a run of newlines split across deltas as one break, and CRLF like LF', () => {
    const { handlers, spoken } = recorder()
    const chunker = createParagraphChunker('m', handlers)
    chunker.push('a\r\n')
    chunker.push('\r\n')
    chunker.push('\nb')
    chunker.flush()
    expect(spoken()).toEqual(['a', 'b'])
    expect(chunker.paragraphs).toEqual(['a', 'b'])
  })

  it('never opens a block for whitespace between paragraphs', () => {
    const { events, handlers } = recorder()
    const chunker = createParagraphChunker('m', handlers)
    chunker.push('a\n   \n  ')
    chunker.push('b')
    chunker.flush()
    expect(events.filter((e) => e.startsWith('start'))).toHaveLength(2)
  })

  it('abandon closes the open block without speaking it', () => {
    const { events, handlers, spoken } = recorder()
    const chunker = createParagraphChunker('m', handlers)
    chunker.push('half a thou')
    chunker.abandon()
    expect(events.at(-1)).toBe('end m.1 half a thou')
    expect(spoken()).toEqual([])
  })
})

describe('createToolCallAccumulator', () => {
  it('joins a call split across deltas, with the id only on the first', () => {
    const calls = createToolCallAccumulator()
    calls.add([{ index: 0, id: 'a', function: { name: 'get_', arguments: '' } }])
    calls.add([{ index: 0, function: { name: 'temp', arguments: '{"ro' } }])
    calls.add([{ index: 0, function: { arguments: 'om":"x"}' } }])
    expect(calls.finish()).toEqual([
      { id: 'a', type: 'function', function: { name: 'get_temp', arguments: '{"room":"x"}' } },
    ])
  })

  it('keeps parallel calls apart when their fragments interleave', () => {
    const calls = createToolCallAccumulator()
    calls.add([{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x"' } }])
    calls.add([{ index: 1, id: 'b', function: { name: 'two', arguments: '{"y"' } }])
    calls.add([{ index: 0, function: { arguments: ':1}' } }])
    calls.add([{ index: 1, function: { arguments: ':2}' } }])
    expect(calls.finish().map((c) => c.function.arguments)).toEqual(['{"x":1}', '{"y":2}'])
  })

  it('separates whole calls from servers that reuse index 0', () => {
    const calls = createToolCallAccumulator()
    calls.add([{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }])
    calls.add([{ index: 0, id: 'b', function: { name: 'two', arguments: '{}' } }])
    expect(calls.finish().map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('copes with no index, a repeated name, object arguments and a missing id', () => {
    const calls = createToolCallAccumulator()
    calls.add([{ function: { name: 'one' } }])
    calls.add([{ function: { name: 'one', arguments: { room: 'x' } } }])
    const [call] = calls.finish()
    expect(call?.function).toEqual({ name: 'one', arguments: '{"room":"x"}' })
    expect(call?.id).toMatch(/^call_/)
  })

  it('drops a fragment that never got a name', () => {
    const calls = createToolCallAccumulator()
    calls.add([{ index: 0, function: { arguments: '{}' } }])
    expect(calls.finish()).toEqual([])
  })
})

describe('respond', () => {
  let mock: MockOpenAI
  let options: RespondOptions
  const messages = [{ role: 'user' as const, content: 'hello' }]

  beforeAll(async () => { mock = await startMockOpenAI() })
  afterAll(() => mock.close())
  beforeEach(() => {
    mock.requests.length = 0
    mock.authorizations.length = 0
    options = { baseUrl: mock.url, model: 'test' }
  })

  it('streams paragraphs from a server that sends no usage, and sends a plain body', async () => {
    mock.enqueue({ frames: textFrames('One.\n', '\nTwo', '.') })
    const { handlers, spoken } = recorder()
    const result = await respond(messages, handlers, options)
    expect(spoken()).toEqual(['One.', 'Two.'])
    expect(result.finalMessage).toBe('One.\n\nTwo.')
    expect(mock.requests[0]).toEqual({ model: 'test', messages, stream: true })
  })

  it('sends the key only when there is one', async () => {
    mock.enqueue({ frames: textFrames('a') }, { frames: textFrames('b') })
    await respond(messages, recorder().handlers, options)
    await respond(messages, recorder().handlers, { ...options, apiKey: 'secret' })
    expect(mock.authorizations).toEqual([undefined, 'Bearer secret'])
  })

  it('tolerates comments, named events and bad JSON mid-stream', async () => {
    mock.enqueue({
      frames: [
        ': keepalive\n\n',
        chunk({ content: 'ok' }),
        'event: vendor.progress\ndata: {"choices":[{"delta":{"content":"NOT THIS"}}]}\n\n',
        'data: {not json\n\n',
        ...textFrames(' then'),
      ],
    })
    const result = await respond(messages, recorder().handlers, options)
    expect(result.finalMessage).toBe('ok then')
  })

  it('flushes what it has when the stream ends without [DONE]', async () => {
    mock.enqueue({ frames: [chunk({ content: 'cut off' })] })
    const { handlers, spoken } = recorder()
    await respond(messages, handlers, options)
    expect(spoken()).toEqual(['cut off'])
  })

  it('accepts a plain JSON reply from a server that ignores stream: true', async () => {
    mock.enqueue({ json: { choices: [{ message: { role: 'assistant', content: 'Whole.\n\nReply.' } }] } })
    const { handlers, spoken } = recorder()
    await respond(messages, handlers, options)
    expect(spoken()).toEqual(['Whole.', 'Reply.'])
  })

  it('reports HTTP errors with the status', async () => {
    mock.enqueue({ status: 401, json: { error: { message: 'bad key' } } })
    await expect(respond(messages, recorder().handlers, options)).rejects.toThrow(/LLM 401.*bad key/)
  })

  it('reports errors sent inside the stream and ends the open block', async () => {
    mock.enqueue({ frames: [chunk({ content: 'partial' }), { error: { message: 'overloaded' } }] })
    const { events, handlers, spoken } = recorder()
    await expect(respond(messages, handlers, options)).rejects.toThrow(/overloaded/)
    expect(events.some((e) => e.startsWith('end ') && e.endsWith('partial'))).toBe(true)
    expect(spoken()).toEqual([])
  })

  it('aborts mid-stream: closes the connection, ends the block, speaks nothing more', async () => {
    mock.enqueue({ frames: [chunk({ content: 'First.\n' }), chunk({ content: 'Second' })], hang: true })
    const controller = new AbortController()
    const { events, handlers, spoken } = recorder()
    handlers.onBlockDelta = (id, text) => {
      events.push(`delta ${id} ${text}`)
      if (text === 'Second') controller.abort()
    }
    const before = mock.disconnects()
    await expect(respond(messages, handlers, { ...options, signal: controller.signal }))
      .rejects.toBeInstanceOf(LlmAbortedError)
    expect(spoken()).toEqual(['First.'])
    expect(events.at(-1)?.startsWith('end ')).toBe(true)
    await vi.waitFor(() => expect(mock.disconnects()).toBe(before + 1))
  })

  it('does not call the server when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(respond(messages, recorder().handlers, { ...options, signal: controller.signal }))
      .rejects.toBeInstanceOf(LlmAbortedError)
    expect(mock.requests).toHaveLength(0)
  })

  it('gives up on a stalled stream, but keepalives count as life', async () => {
    mock.enqueue({ frames: [': keepalive\n\n', ': keepalive\n\n', ...textFrames('alive')], delayMs: 40 })
    const alive = await respond(messages, recorder().handlers, { ...options, stallTimeoutMs: 100 })
    expect(alive.finalMessage).toBe('alive')

    mock.enqueue({ frames: [chunk({ content: 'stuck' })], hang: true })
    await expect(respond(messages, recorder().handlers, { ...options, stallTimeoutMs: 50 }))
      .rejects.toThrow(/stalled/)
  })

  it('treats finish_reason "error" as a failed turn', async () => {
    mock.enqueue({ frames: [chunk({ content: 'x' }), chunk({}, 'error'), '[DONE]'] })
    await expect(respond(messages, recorder().handlers, options)).rejects.toThrow(/failed turn/)
  })
})

describe('buildMessages', () => {
  const turn = (role: 'user' | 'assistant', content: string) => ({ role, content })

  it('sends history, then the new message, after an optional system prompt', () => {
    expect(buildMessages([turn('user', 'a'), turn('assistant', 'b')], 'c', 'be brief')).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    expect(buildMessages([], 'c')).toEqual([{ role: 'user', content: 'c' }])
  })

  it('drops the oldest turns over budget and still starts on a user message', () => {
    const history = [turn('user', 'x'.repeat(50)), turn('assistant', 'y'.repeat(10)), turn('user', 'z'), turn('assistant', 'w')]
    expect(buildMessages(history, 'new', undefined, 20)).toEqual([
      { role: 'user', content: 'z' },
      { role: 'assistant', content: 'w' },
      { role: 'user', content: 'new' },
    ])
  })

  it('always keeps the new message, however long', () => {
    expect(buildMessages([turn('user', 'old')], 'x'.repeat(100), undefined, 10)).toEqual([
      { role: 'user', content: 'x'.repeat(100) },
    ])
  })

  it('merges the user turn left behind by a failed response', () => {
    expect(buildMessages([turn('assistant', 'hi'), turn('user', 'lost')], 'retry')).toEqual([
      { role: 'user', content: 'lost\n\nretry' },
    ])
  })
})
