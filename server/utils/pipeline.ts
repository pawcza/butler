import type { ServerEvent, HermesMessage } from '~/shared/types'

const log = createLog('pipeline')

// Common Whisper hallucinations when transcribing silence or background noise.
const WHISPER_HALLUCINATION_PATTERNS: RegExp[] = [
  /^thank(s| you)/i,
  /^you'?re welcome/i,
  /^(please )?(like|subscribe|comment)/i,
  /^(i'?ll )?see you (in |next )/i,
  /^(bye|goodbye|good night)/i,
  /^thanks for (watching|listening|viewing)/i,
  /^(please )?don'?t forget to/i,
  /^(so|okay|well|right|alright|um|uh)[.!,]?$/i,
  /^\.+$/,
  /^\[.*\]$/,
  /^(music|applause|laughter)$/i,
  /^you$/i,
  /^oh$/i,
  /^hmm?$/i,
  /^subs by/i,
  /^translated by/i,
  /^subtitles by/i,
  /^copyright/i,
]

function isWhisperHallucination(text: string): boolean {
  const cleaned = text.replace(/[.!?,;:]+$/, '').trim()
  return WHISPER_HALLUCINATION_PATTERNS.some((p) => p.test(cleaned))
}

type Emitter = (event: ServerEvent) => void

async function speakAndEmit(text: string, session: SessionManager, emit: Emitter): Promise<void> {
  session.setState('SPEAKING')
  try {
    const ttsModel = session.getTtsModel()
    const ttsVoice = session.getTtsVoice()
    const ttsOpts: TtsOptions = {
      ...(ttsModel !== null ? { model: ttsModel } : {}),
      ...(ttsVoice !== null ? { voice: ttsVoice } : {}),
    }
    const audioBuffer = await synthesize(text, ttsOpts)
    emit({ type: 'audio', data: audioBuffer.toString('base64'), format: config.PIPER_RESPONSE_FORMAT })
  } catch (err) {
    emit({ type: 'error', message: `TTS failed: ${err instanceof Error ? err.message : err}` })
  }
}

export async function processAudio(
  audioBuffer: Buffer,
  session: SessionManager,
  emit: Emitter,
): Promise<void> {
  const t0 = Date.now()
  session.setState('LISTENING')

  let transcript: string
  try {
    transcript = await transcribe(audioBuffer)
  } catch (err) {
    emit({ type: 'error', message: `STT failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }
  const sttMs = Date.now() - t0
  log.info(`STT: ${sttMs}ms → "${transcript.trim()}"`)

  const trimmed = transcript.trim()
  emit({ type: 'transcript', text: trimmed })

  if (trimmed.length < 2 || trimmed.split(/\s+/).length < 2) {
    log.warn(`discarding noise transcript: "${trimmed}" (${sttMs}ms wasted)`)
    session.setState('IDLE')
    return
  }

  if (isWhisperHallucination(trimmed)) {
    log.warn(`discarding hallucinated transcript: "${trimmed}" (${sttMs}ms wasted)`)
    session.setState('IDLE')
    return
  }

  await processCommand(transcript, session, emit, t0)
}

export async function processCommand(
  text: string,
  session: SessionManager,
  emit: Emitter,
  startedAt?: number,
): Promise<void> {
  const t0 = startedAt ?? Date.now()
  const lap = () => Date.now() - t0
  session.setState('THINKING')

  const systemPrompt = buildSystemPrompt(session.getPersonality())
  const messages: HermesMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
  ]

  log.info(`▶ "${text}" | system: ${systemPrompt.length}ch`)

  emit({ type: 'response_start' })
  let replyText: string
  try {
    replyText = await chatStream(messages, (token) => emit({ type: 'response_delta', text: token }))
  } catch (err) {
    emit({ type: 'response_end', text: '' })
    emit({ type: 'error', message: `LLM failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }
  replyText = replyText.trim() || 'Done.'
  emit({ type: 'response_end', text: replyText })
  emit({ type: 'response', text: replyText })

  log.info(`+${lap()}ms LLM done → "${replyText.slice(0, 100)}"`)

  const ttsStart = Date.now()
  await speakAndEmit(replyText, session, emit)
  log.info(`tts +${Date.now() - ttsStart}ms | total +${lap()}ms`)
  session.setState('IDLE')
}
