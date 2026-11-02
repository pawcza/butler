/**
 * A small OpenAI-shaped server for tests and offline demos. It spends nothing and needs no
 * model: `pnpm mock` serves canned chat, speech and transcription responses.
 *
 * Tests queue scripted responses; with an empty queue it plays the demo reply.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A raw string is written as is; anything else becomes one `data:` frame. */
export type Frame = string | Record<string, unknown>

export interface ScriptedResponse {
  frames?: Frame[]
  delayMs?: number
  /** Keep the connection open after the last frame instead of ending the stream. */
  hang?: boolean
  /** Reply with this status and JSON body instead of a stream. */
  status?: number
  json?: unknown
}

export interface MockOpenAI {
  url: string
  /** Bodies of every chat completion request, in order. */
  requests: Array<Record<string, unknown>>
  /** Authorization header of every chat completion request. */
  authorizations: Array<string | undefined>
  /** Streams the client hung up on before they finished. */
  disconnects: () => number
  enqueue: (...responses: ScriptedResponse[]) => void
  close: () => Promise<void>
}

export const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Frame => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  model: 'mock',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

export const textFrames = (...parts: string[]): Frame[] => [
  ...parts.map((content) => chunk({ content })),
  chunk({}, 'stop'),
  '[DONE]',
]

/** One tool call, split into many deltas the way OpenAI streams them. */
export const toolCallFrames = (name: string, args: string, id = 'call_1'): Frame[] => {
  const middle = Math.floor(args.length / 2)
  return [
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, middle) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] }),
    chunk({}, 'tool_calls'),
    '[DONE]',
  ]
}

const DEMO_REPLY = [
  'Good evening. Everything is running smoothly.',
  'I answer in short paragraphs, and each one is spoken as soon as it is complete.',
]

function demoResponse(body: Record<string, unknown>): ScriptedResponse {
  const messages = body['messages'] as Array<{ role: string }>
  const tools = body['tools'] as Array<{ function: { name: string } }> | undefined
  const toolName = tools?.[0]?.function.name
  if (toolName && messages.at(-1)?.role === 'user') {
    return { frames: toolCallFrames(toolName, '{"room":"living room"}'), delayMs: 300 }
  }
  const parts = DEMO_REPLY.join('\n\n').match(/\S+\s*/g) ?? []
  return { frames: textFrames(...parts), delayMs: 60 }
}

/** One second of a quiet sine wave, so the avatar has real audio energy to react to. */
function sineWav(seconds = 1.5): Buffer {
  const sampleRate = 16000
  const samples = Math.floor(sampleRate * seconds)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVE', 8); wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const envelope = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / sampleRate)
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 6000 * envelope), 44 + i * 2)
  }
  return wav
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part as Buffer)
  return Buffer.concat(parts)
}

export async function startMockOpenAI(port = 0): Promise<MockOpenAI> {
  const queue: ScriptedResponse[] = []
  const requests: Array<Record<string, unknown>> = []
  const authorizations: Array<string | undefined> = []
  let disconnects = 0

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse((await readBody(req)).toString('utf-8')) as Record<string, unknown>
    requests.push(body)
    authorizations.push(req.headers.authorization)
    const scripted = queue.shift() ?? demoResponse(body)

    if (scripted.status !== undefined || scripted.json !== undefined) {
      res.writeHead(scripted.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(scripted.json ?? { error: { message: 'mock failure' } }))
      return
    }

    let finished = false
    res.on('close', () => { if (!finished) disconnects += 1 })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const frame of scripted.frames ?? []) {
      if (scripted.delayMs) await sleep(scripted.delayMs)
      if (typeof frame !== 'string') res.write(`data: ${JSON.stringify(frame)}\n\n`)
      else if (frame === '[DONE]') res.write('data: [DONE]\n\n')
      else res.write(frame)
    }
    if (scripted.hang) return
    finished = true
    res.end()
  }

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://mock').pathname
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      void chat(req, res)
    } else if (req.method === 'POST' && path === '/v1/audio/speech') {
      void readBody(req).then(() => {
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(sineWav())
      })
    } else if (req.method === 'POST' && path === '/v1/audio/transcriptions') {
      void readBody(req).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: '' }))
      })
    } else if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-tts', task: 'text-to-speech', voices: ['mock-voice'] }] }))
    } else {
      res.writeHead(404).end()
    }
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const { port: bound } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${bound}/v1`,
    requests,
    authorizations,
    disconnects: () => disconnects,
    enqueue: (...responses) => { queue.push(...responses) },
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

if (process.argv[1]?.endsWith('mock-openai.ts')) {
  const mock = await startMockOpenAI(Number(process.env['PORT'] ?? 4010))
  console.log(`Mock OpenAI server at ${mock.url}`)
}
