import { z } from 'zod'
import { createLog } from './log'

const baseUrl = (name: string) =>
  z.string().url(`${name} must be a valid URL`).transform((url) => url.replace(/\/+$/, ''))

const schema = z.object({
  LLM_BASE_URL: baseUrl('LLM_BASE_URL').default('http://localhost:11434/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string({ required_error: 'LLM_MODEL is required' }).min(1),
  LLM_SYSTEM_PROMPT: z.string().optional(),
  LLM_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).default(8),
  STT_BASE_URL: baseUrl('STT_BASE_URL').optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().min(1).default('whisper-1'),
  TTS_BASE_URL: baseUrl('TTS_BASE_URL').optional(),
  TTS_API_KEY: z.string().optional(),
  TTS_MODEL: z.string().min(1).default('speaches-ai/Kokoro-82M-v1.0-ONNX'),
  TTS_VOICE: z.string().min(1).default('af_heart'),
  TTS_RESPONSE_FORMAT: z.enum(['mp3', 'wav']).default('mp3'),
  /** Inline JSON, or a path to a JSON file. See the MCP section of the README. */
  MCP_SERVERS: z.string().optional(),
  DATA_DIR: z.string().min(1).default('./data'),
  WAKE_WORD: z.string().min(1).default('butler'),
  AUTH_USER: z.string().min(1).optional(),
  AUTH_PASS: z.string().min(1).optional(),
})

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
export type Config = typeof config
