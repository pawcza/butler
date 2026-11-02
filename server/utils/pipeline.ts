import type { ConversationThread, ServerEvent } from '~/shared/types'

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

export function newTranscriptId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

type Emitter = (event: ServerEvent) => void

async function speakChunk(text: string, session: SessionManager, emit: Emitter, signal: AbortSignal): Promise<void> {
  if (!config.TTS_BASE_URL || signal.aborted) return
  session.setState('SPEAKING')
  try {
    const ttsModel = session.getTtsModel()
    const ttsVoice = session.getTtsVoice()
    const ttsOpts: TtsOptions = {
      ...(ttsModel !== null ? { model: ttsModel } : {}),
      ...(ttsVoice !== null ? { voice: ttsVoice } : {}),
    }
    const audioBuffer = await synthesize(text, ttsOpts)
    emit({ type: 'audio', data: audioBuffer.toString('base64'), format: config.TTS_RESPONSE_FORMAT })
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

  emit({ type: 'transcript', id: newTranscriptId(), text: trimmed })
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

  log.info(`▶ "${text}"`)

  // A session starts without a thread; its first message opens one. So does a thread that
  // has been deleted since this session picked it.
  let thread: ConversationThread | null
  let threadId: string
  try {
    const selected = session.getConversationId()
    thread = selected ? await conversationStore.thread(selected) : null
    if (thread) {
      threadId = thread.conversation.id
    } else {
      const conversation = await conversationStore.create()
      threadId = conversation.id
      session.setConversationId(threadId)
      emit({ type: 'conversation', conversation })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.fail(`could not open a conversation: ${msg}`)
    emit({ type: 'error', message: `Conversation store failed: ${msg}` })
    session.setState('IDLE')
    return
  }

  const keep = (role: 'user' | 'assistant', content: string) =>
    conversationStore.append(threadId, role, content).catch((err: unknown) => {
      log.warn(`failed to store ${role} turn: ${err instanceof Error ? err.message : err}`)
    })
  const userText = text.trim()
  const messages = buildMessages(thread?.items ?? [], userText, config.LLM_SYSTEM_PROMPT)
  const userKept = keep('user', userText)
  const signal = session.beginTurn()

  emit({ type: 'response_start' })

  // Serialize TTS so audio events emit in order even though multiple chunks may synthesize
  // concurrently. Each chunk is chained; a failed synth doesn't stop the next one.
  let ttsChain: Promise<void> = Promise.resolve()
  let spokenCount = 0

  let finalMessage: string
  try {
    const result = await respond(messages, {
      onBlockStart: (blockId, kind, meta) => {
        const evt: ServerEvent = { type: 'block_start', blockId, kind }
        if (meta.tool !== undefined) evt.tool = meta.tool
        emit(evt)
      },
      onBlockDelta: (blockId, delta) => {
        emit({ type: 'block_delta', blockId, text: delta })
      },
      onBlockEnd: (blockId, full) => {
        emit({ type: 'block_end', blockId, text: full })
      },
      onSpeakChunk: (chunk) => {
        spokenCount += 1
        ttsChain = ttsChain.catch(() => {}).then(() => speakChunk(chunk, session, emit, signal))
      },
    }, {
      baseUrl: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY,
      model: config.LLM_MODEL,
      tools: mcpToolbox,
      maxToolIterations: config.LLM_MAX_TOOL_ITERATIONS,
      signal,
    })
    finalMessage = result.finalMessage.trim()
  } catch (err) {
    await userKept
    if (err instanceof LlmAbortedError) {
      log.info('turn aborted, client disconnected')
      session.setState('IDLE')
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    log.fail(`respond threw: ${msg}`)
    emit({ type: 'response_end', text: '' })
    emit({ type: 'error', message: `LLM failed: ${msg}` })
    session.setState('IDLE')
    return
  }

  // If the model produced no message blocks at all, speak a minimal fallback so the user
  // hears *something* rather than silence after the spinner stops.
  if (spokenCount === 0) {
    const fallback = finalMessage || 'Done.'
    ttsChain = ttsChain.catch(() => {}).then(() => speakChunk(fallback, session, emit, signal))
    if (!finalMessage) finalMessage = fallback
  }

  emit({ type: 'response_end', text: finalMessage })
  emit({ type: 'response', text: finalMessage })
  // after the user's line, so the thread reads in order
  await userKept.then(() => keep('assistant', finalMessage))

  log.info(`+${lap()}ms LLM done (chunks=${spokenCount}, ${finalMessage.length}ch total)`)

  const ttsStart = Date.now()
  await ttsChain.catch(() => {})
  log.info(`tts drained +${Date.now() - ttsStart}ms | total +${lap()}ms`)
  session.setState('IDLE')
}
