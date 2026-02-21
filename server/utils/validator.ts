import { isValidTool, isValidEntity } from './registry'
import { z } from 'zod'

const toolCallSchema = z.object({
  tool: z.string().min(1),
  entity_id: z.string().min(1),
})

export type ToolCall = z.infer<typeof toolCallSchema> & Record<string, unknown>

export type ValidatorResult =
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'conversation'; text: string }
  | { type: 'error'; message: string }

/**
 * Walks a string character-by-character to find the outermost JSON object or array,
 * correctly handling nested braces/brackets and string literals with escape sequences.
 */
function extractJson(text: string): string | null {
  let start = -1
  let openChar: '{' | '[' | null = null
  let closeChar: '}' | ']' | null = null

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      start = i
      openChar = ch
      closeChar = ch === '{' ? '}' : ']'
      break
    }
  }

  if (start === -1 || openChar === null || closeChar === null) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === openChar) depth++
    else if (ch === closeChar) {
      depth--
      if (depth === 0) return text.substring(start, i + 1)
    }
  }

  return null
}

export function validate(raw: string): ValidatorResult {
  const stripped = raw.replace(/^MODE\s*\d+\s*:\s*/i, '').trim()
  const jsonStr = extractJson(stripped)

  if (jsonStr === null) {
    return { type: 'conversation', text: stripped }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { type: 'error', message: `Malformed JSON from LLM: ${jsonStr.substring(0, 120)}` }
  }

  const rawCalls = Array.isArray(parsed) ? parsed : [parsed]
  const calls: ToolCall[] = []

  for (const rawCall of rawCalls) {
    const result = toolCallSchema.safeParse(rawCall)
    if (!result.success) {
      return { type: 'error', message: `Invalid tool call structure: ${result.error.errors[0]?.message ?? 'unknown'}` }
    }

    const { tool, entity_id } = result.data

    if (!isValidTool(tool)) {
      return { type: 'error', message: `Hallucinated tool name: "${tool}"` }
    }
    if (!isValidEntity(entity_id)) {
      return { type: 'error', message: `Hallucinated entity_id: "${entity_id}"` }
    }

    const extra =
      typeof rawCall === 'object' && rawCall !== null ? (rawCall as Record<string, unknown>) : {}
    calls.push({ ...extra, tool, entity_id })
  }

  return { type: 'tool_calls', calls }
}
