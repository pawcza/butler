import { z } from 'zod'
import { createLog } from './log'
import { oidcShape, refineOidc, resolveOidc } from './oidc-config'

const baseUrl = (name: string) =>
  z.string().url(`${name} must be a valid URL`).transform((url) => url.replace(/\/+$/, ''))

const languageVoices = z.record(z.object({ model: z.string().min(1), voice: z.string().min(1) }))

const schema = z.object({
  LLM_BASE_URL: baseUrl('LLM_BASE_URL').default('http://localhost:11434/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string({ required_error: 'LLM_MODEL is required' }).min(1),
  LLM_SYSTEM_PROMPT: z.string().optional(),
  /** Sent as `metadata.locale`, for servers that localise their replies. */
  LLM_LOCALE: z.string().min(1).optional(),
  /** Sent as the OpenAI `user` field when nobody is signed in. A signed-in user's OIDC `sub` wins. */
  LLM_USER: z.string().min(1).optional(),
  /**
   * `1`: ask the server for its named SSE events (`x-persona-events: 1`), so tools it runs itself
   * show as they run. Only for a server that knows the header (persona); others ignore it.
   */
  LLM_PERSONA_EVENTS: z.enum(['0', '1']).default('0').transform((value) => value === '1'),
  LLM_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).default(8),
  STT_BASE_URL: baseUrl('STT_BASE_URL').optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().min(1).default('whisper-1'),
  TTS_BASE_URL: baseUrl('TTS_BASE_URL').optional(),
  TTS_API_KEY: z.string().optional(),
  TTS_MODEL: z.string().min(1).default('speaches-ai/Kokoro-82M-v1.0-ONNX'),
  TTS_VOICE: z.string().min(1).default('af_heart'),
  TTS_RESPONSE_FORMAT: z.enum(['mp3', 'wav']).default('mp3'),
  /**
   * `1`: when a turn starts, synthesize one throwaway word in the background so an engine that
   * unloads its model between uses has it loaded by the first sentence. Costs one tiny synthesis
   * per turn, skipped when one finished in the last 30 seconds.
   */
  TTS_WARMUP: z.enum(['0', '1']).default('0').transform((value) => value === '1'),
  /**
   * JSON map of language code to the voice that reads it, e.g.
   * `{"pl":{"model":"speaches-ai/piper-pl_PL-gosia-medium","voice":"gosia"}}`. A reply paragraph
   * in one of these languages is spoken with that voice; anything else keeps the default.
   */
  TTS_VOICES: z.string().optional().transform((raw, ctx) => {
    if (raw === undefined) return {}
    try {
      return languageVoices.parse(JSON.parse(raw))
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TTS_VOICES must be JSON like {"pl":{"model":"…","voice":"…"}}' })
      return z.NEVER
    }
  }),
  /** Inline JSON, or a path to a JSON file. See the MCP section of the README. */
  MCP_SERVERS: z.string().optional(),
  DATA_DIR: z.string().min(1).default('./data'),
  WAKE_WORD: z.string().min(1).default('butler'),
  ...oidcShape,
}).superRefine(refineOidc)

// `FOO=` in an env file means unset, not an empty value.
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''))
const result = schema.safeParse(env)

if (!result.success) {
  const log = createLog('config')
  const errors = result.error.errors
    .map((e) => `  • ${e.path.join('.')}: ${e.message}`)
    .join('\n')
  log.fail(`Invalid environment variables:\n${errors}\n`)
  log.fail('Copy .env.example to .env and fill in the values.')
  process.exit(1)
}

export const config = result.data
export const oidc = resolveOidc(config)
export type Config = typeof config
