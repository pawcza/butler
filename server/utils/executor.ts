import type { ToolCall } from './validator'

export interface ExecutionResult {
  tool: string
  entity_id: string
  success: boolean
  error?: string
}

export async function execute(calls: ToolCall[]): Promise<ExecutionResult[]> {
  const { tools } = getRegistry()
  const results: ExecutionResult[] = []

  for (const call of calls) {
    const toolDef = tools.find((t) => t.name === call.tool)
    if (!toolDef) {
      results.push({ tool: call.tool, entity_id: call.entity_id, success: false, error: `No definition for tool: ${call.tool}` })
      continue
    }

    const { tool: _tool, entity_id, ...serviceData } = call
    const hasExtra = Object.keys(serviceData).length > 0
    const params = hasExtra
      ? { domain: toolDef.domain, service: toolDef.service, entity_id, service_data: serviceData }
      : { domain: toolDef.domain, service: toolDef.service, entity_id }

    console.log(
      `[executor] → ${toolDef.domain}.${toolDef.service} | entity: ${entity_id}` +
        (hasExtra ? ` | data: ${JSON.stringify(serviceData)}` : ''),
    )

    try {
      const haResponse = await callService(params)
      console.log(`[executor] ✓ ${entity_id} — ${JSON.stringify(haResponse)}`)
      results.push({ tool: call.tool, entity_id, success: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[executor] ✗ ${entity_id} — ${message}`)
      results.push({ tool: call.tool, entity_id, success: false, error: message })
    }
  }

  return results
}
