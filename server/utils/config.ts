import { z } from 'zod'

const schema = z.object({
  HA_URL: z.string().url('HA_URL must be a valid URL'),
  HA_TOKEN: z.string().min(1, 'HA_TOKEN is required'),
  OLLAMA_URL: z.string().url('OLLAMA_URL must be a valid URL'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:14b'),
  WHISPER_URL: z.string().url('WHISPER_URL must be a valid URL'),
  PIPER_URL: z.string().url('PIPER_URL must be a valid URL'),
  PIPER_MODEL: z.string().min(1).default('speaches-ai/Kokoro-82M-v1.0-ONNX'),
  PIPER_VOICE: z.string().min(1).default('af_heart'),
  PIPER_RESPONSE_FORMAT: z.enum(['mp3', 'wav']).default('mp3'),
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
