/** Execute a single MCP tool via ha-mcp and return the result as text. */
export async function executeMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  console.log(`[executor] → MCP ${name} | args: ${JSON.stringify(args)}`)

  try {
    const result = await callMcpTool(name, args)
    const text = result.content
      .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')

    if (result.isError) {
      console.error(`[executor] ✗ ${name} — ${text}`)
      return `Error: ${text}`
    }

    console.log(`[executor] ✓ ${name}`)
    return text || 'OK'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[executor] ✗ ${name} — ${message}`)
    return `Error: ${message}`
  }
}
