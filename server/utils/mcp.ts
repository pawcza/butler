import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { config } from './config'
import type { ToolDefinition, ToolProvider } from './llm'
import { createLog } from './log'

const log = createLog('mcp')

const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 30_000
const RECONNECT_INTERVAL_MS = 60_000
const MAX_RESULT_CHARS = 16_000
/** OpenAI's limit on function names; most compatible servers enforce the same pattern. */
const MAX_TOOL_NAME_LENGTH = 64

const serverSchema = z.union([
  z.object({ url: z.string().url(), headers: z.record(z.string()).optional() }),
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
])

export type McpServerConfig = z.infer<typeof serverSchema>

/**
 * Reads the `MCP_SERVERS` value: inline JSON or a path to a JSON file, either a map of
 * servers or the `{ "mcpServers": { ... } }` shape other MCP clients use. Anything wrong
 * is logged and skipped, because a bad entry must not stop butler.
 */
export function parseMcpConfig(value: string | undefined): Record<string, McpServerConfig> {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    const json = value.trim().startsWith('{') ? value : readFileSync(value, 'utf-8')
    parsed = JSON.parse(json)
  } catch (err) {
    log.fail(`ignoring MCP_SERVERS: ${err instanceof Error ? err.message : err}`)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) {
    log.fail('ignoring MCP_SERVERS: expected a JSON object')
    return {}
  }
  const root = parsed as Record<string, unknown>
  const entries = typeof root['mcpServers'] === 'object' && root['mcpServers'] !== null
    ? root['mcpServers'] as Record<string, unknown>
    : root

  const servers: Record<string, McpServerConfig> = {}
  for (const [name, entry] of Object.entries(entries)) {
    const server = serverSchema.safeParse(entry)
    if (server.success) servers[name] = server.data
    else log.fail(`ignoring MCP server "${name}": it needs either "url" or "command"`)
  }
  return servers
}

interface CallToolContent {
  type: string
  text?: string
}

function formatToolResult(result: Record<string, unknown>): string {
  const content = Array.isArray(result['content']) ? result['content'] as CallToolContent[] : []
  const text = content
    .map((item) => (item.type === 'text' ? item.text ?? '' : `[${item.type} content omitted]`))
    .join('\n')
  const body = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text
  return result['isError'] ? `Error: ${body}` : body
}

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]

interface Connection {
  name: string
  config: McpServerConfig
  client: Client | null
  /** Exposed (prefixed) tool name to the name the server knows it by. */
  toolNames: Map<string, string>
  definitions: ToolDefinition[]
  lastAttempt: number
  connecting: boolean
}

function createTransport(server: McpServerConfig): StreamableHTTPClientTransport | StdioClientTransport {
  if ('url' in server) {
    return new StreamableHTTPClientTransport(
      new URL(server.url),
      server.headers ? { requestInit: { headers: server.headers } } : undefined,
    )
  }
  return new StdioClientTransport({
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  })
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

/** Connects to the configured MCP servers and presents their tools to the model as one list. */
export class McpToolbox implements ToolProvider {
  private readonly connections: Connection[]
  private readonly reconnectIntervalMs: number

  constructor(servers: Record<string, McpServerConfig>, reconnectIntervalMs = RECONNECT_INTERVAL_MS) {
    this.reconnectIntervalMs = reconnectIntervalMs
    this.connections = Object.entries(servers).map(([name, server]) => ({
      name,
      config: server,
      client: null,
      toolNames: new Map(),
      definitions: [],
      lastAttempt: 0,
      connecting: false,
    }))
  }

  /** Resolves once every server has connected or failed. It never rejects. */
  async connect(): Promise<void> {
    await Promise.all(this.connections.map((connection) => this.open(connection)))
  }

  definitions(): ToolDefinition[] {
    this.reconnectDropped()
    return this.connections.flatMap((connection) => connection.definitions)
  }

  async execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const connection = this.connections.find((c) => c.toolNames.has(name))
    const toolName = connection?.toolNames.get(name)
    if (!connection?.client || toolName === undefined) throw new Error(`unknown tool: ${name}`)
    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal, timeout: CALL_TIMEOUT_MS },
      )
      return formatToolResult(result)
    } catch (err) {
      // Not retried: the call may have had a real-world effect. The session may be dead
      // though (a restarted server), so drop it and let a later turn reconnect.
      if (!signal.aborted) this.drop(connection)
      throw err
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map(async (connection) => {
      const client = connection.client
      connection.client = null
      if (client) client.onclose = () => {}
      await client?.close().catch(() => {})
    }))
  }

  private async open(connection: Connection): Promise<void> {
    if (connection.connecting) return
    connection.connecting = true
    connection.lastAttempt = Date.now()
    const client = new Client({ name: 'butler', version: '1.0.0' })
    try {
      await client.connect(createTransport(connection.config), { timeout: CONNECT_TIMEOUT_MS })
      const tools = await listAllTools(client)
      this.adopt(connection, client, tools)
      log.ok(`${connection.name}: ${tools.length} tools`)
    } catch (err) {
      log.fail(`${connection.name}: ${err instanceof Error ? err.message : err}`)
      await client.close().catch(() => {})
    } finally {
      connection.connecting = false
    }
  }

  private adopt(connection: Connection, client: Client, tools: McpTool[]): void {
    client.onclose = () => {
      if (connection.client === client) this.drop(connection)
    }
    connection.client = client
    connection.toolNames.clear()
    connection.definitions = tools.map((tool) => {
      const exposed = this.exposedName(connection, tool.name)
      connection.toolNames.set(exposed, tool.name)
      return {
        type: 'function',
        function: {
          name: exposed,
          description: tool.description ?? '',
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      }
    })
  }

  private exposedName(connection: Connection, tool: string): string {
    const base = `${connection.name}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME_LENGTH)
    const taken = (name: string): boolean => this.connections.some((c) => c.toolNames.has(name))
    let name = base
    for (let n = 2; taken(name); n++) {
      name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - String(n).length - 1)}_${n}`
    }
    return name
  }

  private drop(connection: Connection): void {
    const client = connection.client
    connection.client = null
    connection.toolNames.clear()
    connection.definitions = []
    connection.lastAttempt = 0
    if (client) {
      client.onclose = () => {}
      void client.close().catch(() => {})
    }
    log.warn(`${connection.name}: connection lost`)
  }

  private reconnectDropped(): void {
    const now = Date.now()
    for (const connection of this.connections) {
      if (!connection.client && now - connection.lastAttempt >= this.reconnectIntervalMs) {
        void this.open(connection)
      }
    }
  }
}

export const mcpToolbox = new McpToolbox(parseMcpConfig(config.MCP_SERVERS))
