import { z } from 'zod'

const schema = z.object({
  HERMES_API_URL: z.string().url('HERMES_API_URL must be a valid URL').default('http://hermes-agent:8642/v1'),
  HERMES_API_KEY: z.string().min(1, 'HERMES_API_KEY is required'),
  HERMES_MODEL: z.string().min(1).default('claude-sonnet-4-6'),
  /** conversation-api's home-app door: conversation threads live there (`/conversations`). */
  PERSONA_API_URL: z.string().url('PERSONA_API_URL must be a valid URL').default('http://conversation-api:3001/v1'),
  /** butler's key from conversation-api's LLM_PROXY_KEYS. */
  PERSONA_API_KEY: z.string().min(1, 'PERSONA_API_KEY is required'),
  WHISPER_URL: z.string().url('WHISPER_URL must be a valid URL'),
  PIPER_URL: z.string().url('PIPER_URL must be a valid URL'),
  PIPER_MODEL: z.string().min(1).default('speaches-ai/Kokoro-82M-v1.0-ONNX'),
  PIPER_VOICE: z.string().min(1).default('af_heart'),
  PIPER_RESPONSE_FORMAT: z.enum(['mp3', 'wav']).default('mp3'),
  AUTH_USER: z.string().min(1).optional(),
  AUTH_PASS: z.string().min(1).optional(),
})

const result = schema.safeParse(process.env)

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
