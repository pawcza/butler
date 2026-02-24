import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

let client: Client | null = null
let toolCache: McpToolDef[] = []
let toolNameSet: Set<string> = new Set()

async function createClient(): Promise<Client> {
  const mcpClient = new Client({ name: 'butler-core', version: '1.0.0' })
  const url = new URL(config.MCP_URL)

  try {
    const transport = new StreamableHTTPClientTransport(url) as unknown as Transport
    await mcpClient.connect(transport)
  } catch {
    console.log('[mcp] Streamable HTTP failed, falling back to SSE transport')
    const transport = new SSEClientTransport(url) as unknown as Transport
    await mcpClient.connect(transport)
  }

  return mcpClient
}

export async function connectMcp(): Promise<void> {
  client = await createClient()
  await refreshMcpTools()
  console.log(`[mcp] Connected. ${toolCache.length} HA tools discovered.`)
}

export async function refreshMcpTools(): Promise<void> {
  if (!client) throw new Error('[mcp] Not connected')
  const result = await client.listTools()
  toolCache = result.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }))
  toolNameSet = new Set(toolCache.map((t) => t.name))
}

export function getMcpTools(): McpToolDef[] {
  return toolCache
}

export function isMcpTool(name: string): boolean {
  return toolNameSet.has(name)
}

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  if (!client) throw new Error('[mcp] Not connected')

  try {
    const result = await client.callTool({ name, arguments: args })
    return result as McpCallResult
  } catch (err) {
    // Single retry with reconnect on transport failure
    console.warn(`[mcp] callTool failed for "${name}", reconnecting: ${err instanceof Error ? err.message : err}`)
    client = await createClient()
    const result = await client.callTool({ name, arguments: args })
    return result as McpCallResult
  }
}
