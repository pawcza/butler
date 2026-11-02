import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LlmAbortedError, respond, type BlockHandlers, type RespondOptions, type ToolProvider } from '../server/utils/llm'
import { McpToolbox, parseMcpConfig, type McpServerConfig } from '../server/utils/mcp'
import { createFixtureServer } from './support/mcp-fixture'
import { chunk, startMockOpenAI, textFrames, toolCallFrames, type MockOpenAI } from './support/mock-openai'

const stdioFixture: McpServerConfig = {
  command: process.execPath,
  args: ['--experimental-strip-types', '--no-warnings', resolve('tests/support/mcp-fixture.ts')],
}

function recorder() {
  const blocks: Array<{ kind: string; tool?: string; text: string }> = []
  const byId = new Map<string, { kind: string; tool?: string; text: string }>()
  const handlers: BlockHandlers = {
    onBlockStart: (id, kind, meta) => {
      const block = { kind, text: '', ...meta }
      blocks.push(block)
      byId.set(id, block)
    },
    onBlockDelta: () => {},
    onBlockEnd: (id, text) => {
      const block = byId.get(id)
      if (block) block.text = text
    },
    onSpeakChunk: () => {},
  }
  return { blocks, handlers }
}

async function startHttpFixture(requestedPort = 0): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    // Without a session id generator the transport is stateless: one server per request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    void createFixtureServer().connect(transport).then(() => transport.handleRequest(req, res))
  })
  await new Promise<void>((done) => server.listen(requestedPort, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () => new Promise((done) => {
      server.closeAllConnections()
      server.close(() => done())
    }),
  }
}

describe('tool loop', () => {
  let mock: MockOpenAI
  let toolbox: McpToolbox
  let options: RespondOptions
  const messages = [{ role: 'user' as const, content: 'How warm is the kitchen?' }]

  beforeAll(async () => {
    mock = await startMockOpenAI()
    toolbox = new McpToolbox({ home: stdioFixture })
    await toolbox.connect()
  })
  afterAll(async () => {
    await toolbox.close()
    await mock.close()
  })
  beforeEach(() => {
    mock.requests.length = 0
    options = { baseUrl: mock.url, model: 'test', tools: toolbox }
  })

  it('offers tools, executes the call, feeds the result back, and shows it all as blocks', async () => {
    mock.enqueue(
      { frames: [chunk({ content: 'Checking.\n' }), ...toolCallFrames('home__get_temperature', '{"room":"kitchen"}')] },
      { frames: textFrames('It is 21.5 degrees.') },
    )
    const { blocks, handlers } = recorder()
    const result = await respond(messages, handlers, options)

    expect(result.finalMessage).toBe('Checking.\n\nIt is 21.5 degrees.')
    expect(blocks).toEqual([
      { kind: 'message', text: 'Checking.' },
      { kind: 'tool_call', tool: 'home__get_temperature', text: '{"room":"kitchen"}' },
      { kind: 'tool_output', text: 'kitchen: 21.5 C' },
      { kind: 'message', text: 'It is 21.5 degrees.' },
    ])

    const first = mock.requests[0] as { tools: Array<{ function: { name: string } }> }
    expect(first.tools.map((t) => t.function.name)).toEqual(['home__get_temperature', 'home__broken'])

    expect(mock.requests[1]?.['messages']).toEqual([
      ...messages,
      {
        role: 'assistant',
        content: 'Checking.\n',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'home__get_temperature', arguments: '{"room":"kitchen"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'kitchen: 21.5 C' },
    ])
  })

  it('runs parallel calls and answers each by id', async () => {
    mock.enqueue(
      {
        frames: [
          chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'home__get_temperature', arguments: '{"room":"attic"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'home__get_temperature', arguments: '{"room":"cellar"}' } }] }),
          chunk({}, 'tool_calls'),
          '[DONE]',
        ],
      },
      { frames: textFrames('Done.') },
    )
    await respond(messages, recorder().handlers, options)
    const sent = mock.requests[1]?.['messages'] as Array<{ role: string; tool_call_id?: string; content: string }>
    expect(sent.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'attic: 21.5 C' },
      { role: 'tool', tool_call_id: 'b', content: 'cellar: 21.5 C' },
    ])
  })

  it('keeps going when finish_reason says "stop" but tool calls arrived', async () => {
    mock.enqueue(
      {
        frames: [
          chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'home__get_temperature', arguments: { room: 'hall' } } }] }),
          chunk({}, 'stop'),
          '[DONE]',
        ],
      },
      { frames: textFrames('Done.') },
    )
    const { blocks, handlers } = recorder()
    await respond(messages, handlers, options)
    expect(blocks.find((b) => b.kind === 'tool_output')?.text).toBe('hall: 21.5 C')
  })

  it('feeds failures back to the model: tool errors, unknown tools, bad JSON', async () => {
    mock.enqueue(
      { frames: toolCallFrames('home__broken', '{}') },
      { frames: toolCallFrames('home__nope', '{}') },
      { frames: toolCallFrames('home__get_temperature', '{"room":') },
      { frames: textFrames('Sorry, that failed.') },
    )
    const { blocks, handlers } = recorder()
    const result = await respond(messages, handlers, options)
    const outputs = blocks.filter((b) => b.kind === 'tool_output').map((b) => b.text)
    expect(outputs[0]).toBe('Error: sensor offline')
    expect(outputs[1]).toBe('Error: unknown tool: home__nope')
    expect(outputs[2]).toMatch(/^Error: /)
    expect(result.finalMessage).toBe('Sorry, that failed.')
  })

  it('stops at the iteration cap by asking once more without tools', async () => {
    mock.enqueue(
      { frames: toolCallFrames('home__get_temperature', '{"room":"a"}') },
      { frames: toolCallFrames('home__get_temperature', '{"room":"b"}') },
      { frames: textFrames('Enough.') },
    )
    const result = await respond(messages, recorder().handlers, { ...options, maxToolIterations: 2 })
    expect(result.finalMessage).toBe('Enough.')
    expect(mock.requests).toHaveLength(3)
    expect(mock.requests[1]).toHaveProperty('tools')
    expect(mock.requests[2]).not.toHaveProperty('tools')
  })

  it('stops the loop when aborted during a tool call', async () => {
    const controller = new AbortController()
    const tools: ToolProvider = {
      definitions: () => [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
      execute: async () => {
        controller.abort()
        return 'late'
      },
    }
    mock.enqueue({ frames: toolCallFrames('t', '{}') })
    await expect(respond(messages, recorder().handlers, { ...options, tools, signal: controller.signal }))
      .rejects.toBeInstanceOf(LlmAbortedError)
    expect(mock.requests).toHaveLength(1)
  })

  it('sends no tools field at all when nothing is configured', async () => {
    mock.enqueue({ frames: textFrames('Plain chat.') })
    const empty = new McpToolbox({})
    await empty.connect()
    await respond(messages, recorder().handlers, { ...options, tools: empty })
    expect(mock.requests[0]).not.toHaveProperty('tools')
  })
})

describe('McpToolbox', () => {
  it('talks to HTTP servers too', async () => {
    const http = await startHttpFixture()
    const toolbox = new McpToolbox({ remote: { url: http.url } })
    await toolbox.connect()
    expect(toolbox.definitions().map((t) => t.function.name)).toContain('remote__get_temperature')
    const output = await toolbox.execute('remote__get_temperature', { room: 'hall' }, new AbortController().signal)
    expect(output).toBe('hall: 21.5 C')
    await toolbox.close()
    await http.close()
  })

  it('survives servers that fail, and still serves the healthy one', async () => {
    const toolbox = new McpToolbox({
      missing: { command: '/nonexistent/mcp-server' },
      refused: { url: 'http://127.0.0.1:9/mcp' },
      crashes: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
      home: stdioFixture,
    })
    await toolbox.connect()
    expect(toolbox.definitions().map((t) => t.function.name)).toEqual(['home__get_temperature', 'home__broken'])
    await toolbox.close()
  })

  it('picks up a server that was down at startup on a later turn', async () => {
    const reserved = await startHttpFixture()
    await reserved.close()

    const toolbox = new McpToolbox({ remote: { url: reserved.url } }, 0)
    await toolbox.connect()
    expect(toolbox.definitions()).toEqual([])

    const http = await startHttpFixture(reserved.port)
    await expect.poll(() => toolbox.definitions().length).toBeGreaterThan(0)
    await toolbox.close()
    await http.close()
  })

  it('reports a dead connection to the model once, then drops its tools', async () => {
    const http = await startHttpFixture()
    const toolbox = new McpToolbox({ remote: { url: http.url } }, 60_000)
    await toolbox.connect()
    await http.close()

    await expect(toolbox.execute('remote__get_temperature', { room: 'x' }, new AbortController().signal)).rejects.toThrow()
    await toolbox.execute('remote__get_temperature', { room: 'x' }, new AbortController().signal)
      .catch((err: Error) => expect(err.message).toMatch(/unknown tool/))
    await toolbox.close()
  })

  it('makes names safe for the API and keeps them unique', async () => {
    const toolbox = new McpToolbox({ 'my server!': stdioFixture, 'my server?': stdioFixture })
    await toolbox.connect()
    const names = toolbox.definitions().map((t) => t.function.name)
    expect(new Set(names).size).toBe(4)
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    await toolbox.close()
  })
})

describe('parseMcpConfig', () => {
  it('is empty when unset', () => {
    expect(parseMcpConfig(undefined)).toEqual({})
    expect(parseMcpConfig('  ')).toEqual({})
  })

  it('reads inline JSON in both shapes', () => {
    const server = { url: 'http://localhost:1/mcp' }
    expect(parseMcpConfig(JSON.stringify({ a: server }))).toEqual({ a: server })
    expect(parseMcpConfig(JSON.stringify({ mcpServers: { a: server } }))).toEqual({ a: server })
  })

  it('reads a file path', () => {
    expect(parseMcpConfig(resolve('tests/support/mcp-config.json'))).toEqual({
      time: { command: 'uvx', args: ['mcp-server-time'] },
    })
  })

  it('skips bad entries and bad input without throwing', () => {
    expect(parseMcpConfig('{"good":{"command":"x"},"bad":{"nope":1}}')).toEqual({ good: { command: 'x' } })
    expect(parseMcpConfig('{not json')).toEqual({})
    expect(parseMcpConfig('/nonexistent/mcp.json')).toEqual({})
  })
})
