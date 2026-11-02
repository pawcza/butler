/** A tiny MCP server for tests. Run directly it serves over stdio. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export function createFixtureServer(): Server {
  const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'get_temperature',
        description: 'Read the temperature of a room',
        inputSchema: { type: 'object' as const, properties: { room: { type: 'string' } }, required: ['room'] },
      },
      {
        name: 'broken',
        description: 'Always fails',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name === 'broken') {
      return { isError: true, content: [{ type: 'text' as const, text: 'sensor offline' }] }
    }
    return { content: [{ type: 'text' as const, text: `${String(request.params.arguments?.['room'])}: 21.5 C` }] }
  })

  return server
}

if (process.argv[1]?.endsWith('mcp-fixture.ts')) {
  await createFixtureServer().connect(new StdioServerTransport())
}
