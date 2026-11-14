import type { ConversationThread, ServerEvent } from '~/shared/types'
import { detectLanguage } from '~/shared/text'
import { PCM_SAMPLE_RATE } from '~/shared/audio'
import { config } from './config'
import { conversationStore } from './conversations'
import { LiveTranscription } from './live-transcription'
import { LlmAbortedError, buildMessages, respond } from './llm'
import { createLog } from './log'
import { mcpToolbox } from './mcp'
import type { SessionManager } from './session'
import { createSpeechQueue, type SpeechQueue } from './speech-queue'
import { pcmToWav, transcribe } from './stt'
import { synthesize, voiceFor, type TtsOptions } from './tts'

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
  // Polish: the same sign-offs and credits. Only the whole phrase counts, so "Dziękuję, zgaś światło" is a command.
  /^dziękuj(ę|emy)( (bardzo|wszystkim|państwu|serdecznie))* za (uwagę|oglądanie|obejrzenie|wysłuchanie)/iu,
  /^napisy\s*:/iu,
  /^napisy (stworzone|wykonane|zrobione|przygotowane|przetłumaczone|tłumaczone) /iu,
  /^tłumaczenie( i napisy)?\s*:/iu,
  /amara\.org/i,
  /^zapraszam (do|na) (subskrypcji|subskrybowania|obserwowania|oglądania|obejrzenia|kanał)/iu,
  /^(za)?subskrybuj (kanał|nasz)/iu,
  /^zostaw (łapkę|like|suba|subskrypcję)/iu,
  /^do zobaczenia( (w|na) (następnym|kolejnym|przyszłym) \p{L}+)?$/iu,
  /^do zobaczenia (w|na) (następnym|kolejnym|przyszłym) /iu,
  /^(muzyka|brawa|oklaski|śmiech)$/iu,
  /^\(.*\)$/,
]

export function isWhisperHallucination(text: string): boolean {
  const cleaned = text.replace(/[.!?,;:]+$/, '').trim()
  return WHISPER_HALLUCINATION_PATTERNS.some((p) => p.test(cleaned))
}

export function newTranscriptId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

type Emitter = (event: ServerEvent) => void

/** A spoken utterance on its way in. Partials and the final transcript all carry `id`. */
export interface Capture {
  id: string
  live: LiveTranscription
}

/** Opens a capture that reports partial transcripts. `onLimit` fires when it's full. */
export function openCapture(emit: Emitter, onLimit: () => void): Capture {
  const id = newTranscriptId()
  const live = new LiveTranscription({
    transcribe: (pcm, signal) => transcribe(pcmToWav(pcm, PCM_SAMPLE_RATE), signal),
    onPartial: (text) => {
      if (!isWhisperHallucination(text)) emit({ type: 'transcript_partial', id, text })
    },
    onPartialError: (err) => log.warn(`partial transcription failed: ${err instanceof Error ? err.message : err}`),
    onLimit,
    sampleRate: PCM_SAMPLE_RATE,
  })
  return { id, live }
}

/** The capture is closed: transcribe all of it, then answer it like a typed command. */
export async function processCapture(capture: Capture, session: SessionManager, emit: Emitter): Promise<void> {
  const t0 = Date.now()
  if (session.isClosed) return
  session.setState('LISTENING')
  const discard = () => {
    emit({ type: 'transcript_discarded', id: capture.id })
    session.setState('IDLE')
  }

  // a socket that closes during the final pass cancels it, even though the capture left the map
  const offClose = session.onClose(() => capture.live.cancel())
  let transcript: string
  try {
    transcript = await capture.live.finish()
  } catch (err) {
    if (session.isClosed) return
    if (capture.live.cancelled) {
      session.setState('IDLE')
      return
    }
    emit({ type: 'error', message: `STT failed: ${err instanceof Error ? err.message : err}` })
    discard()
    return
  } finally {
    offClose()
  }
  if (session.isClosed) return
  if (capture.live.cancelled) {
    session.setState('IDLE')
    return
  }
  const sttMs = Date.now() - t0
  const trimmed = transcript.trim()
  log.info(`STT: ${sttMs}ms after release, ${capture.live.durationMs}ms of audio → "${trimmed}"`)

  if (trimmed.length < 2 || trimmed.split(/\s+/).length < 2) {
    log.warn(`discarding noise transcript: "${trimmed}" (${sttMs}ms wasted)`)
    discard()
    return
  }

  if (isWhisperHallucination(trimmed)) {
    log.warn(`discarding hallucinated transcript: "${trimmed}" (${sttMs}ms wasted)`)
    discard()
    return
  }

  emit({ type: 'transcript', id: capture.id, text: trimmed })
  await processCommand(trimmed, session, emit, t0)
}

export async function processCommand(
  text: string,
  session: SessionManager,
  emit: Emitter,
  startedAt?: number,
): Promise<void> {
  const t0 = startedAt ?? Date.now()
  const lap = () => Date.now() - t0
  if (session.isClosed) return
  session.setState('THINKING')

  log.info(`▶ "${text}"`)

  // A session starts without a thread; its first message opens one. So does a thread that
  // has been deleted since this session picked it.
  let thread: ConversationThread | null
  let threadId: string
  try {
    const selected = session.getConversationId()
    thread = selected ? await conversationStore.thread(selected) : null
    if (session.isClosed) return
    if (thread) {
      threadId = thread.conversation.id
    } else {
      const conversation = await conversationStore.create()
      threadId = conversation.id
      if (session.isClosed) return
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
  const turn = session.beginTurn()
  const { signal } = turn
  const user = session.getUserId() ?? config.LLM_USER

  emit({ type: 'response_start' })

  // Each message block is spoken sentence by sentence. A couple of sentences synthesize at once,
  // but their audio goes out in order, and a failed one doesn't stop the next.
  const speech: SpeechQueue<TtsOptions> | null = config.TTS_BASE_URL
    ? createSpeechQueue<TtsOptions>({
        synthesize,
        emit,
        format: config.TTS_RESPONSE_FORMAT,
        signal,
        onSpeaking: () => session.setState('SPEAKING'),
        // the engine is down: no more speech this turn, and a session that was speaking is just thinking
        onGiveUp: () => session.stopSpeech(),
      })
    : null
  if (speech) session.onStopSpeech(speech.stop)
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
      onSpeakChunk: (blockId, blockText) => {
        spokenCount += 1
        // a block in a language with its own voice is read by it, sentence after sentence
        const language = detectLanguage(blockText, Object.keys(config.TTS_VOICES))
        speech?.speak(blockId, blockText, voiceFor(language))
      },
    }, {
      baseUrl: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY,
      model: config.LLM_MODEL,
      tools: mcpToolbox,
      maxToolIterations: config.LLM_MAX_TOOL_ITERATIONS,
      signal,
      ...(user ? { user } : {}),
      ...(config.LLM_LOCALE ? { locale: config.LLM_LOCALE } : {}),
      ...(config.LLM_PERSONA_EVENTS ? { personaEvents: true } : {}),
    })
    finalMessage = result.finalMessage.trim()
  } catch (err) {
    await userKept
    if (err instanceof LlmAbortedError) {
      if (session.isClosed) {
        log.info('turn aborted, client disconnected')
        session.finishTurn(turn.id)
        return
      }
      // The user pressed talk over the running turn. What was written stays on screen and is
      // stored; the session already belongs to the new capture, so there is no state to reset.
      const partial = err.paragraphs.join('\n\n')
      log.info(`turn interrupted by the user (${partial.length}ch written)`)
      emit({ type: 'response_end', text: partial })
      if (partial) {
        emit({ type: 'response', text: partial })
        await keep('assistant', partial)
      }
      session.finishTurn(turn.id)
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    log.fail(`respond threw: ${msg}`)
    emit({ type: 'response_end', text: '' })
    emit({ type: 'error', message: `LLM failed: ${msg}` })
    // what was already read out may finish; the turn is over once it has
    session.markSpeechOnly()
    await speech?.drained()
    session.finishTurn(turn.id)
    return
  }
  session.markSpeechOnly()

  // If the model produced no message blocks at all, speak a minimal fallback so the user
  // hears *something* rather than silence after the spinner stops.
  if (spokenCount === 0) {
    const fallback = finalMessage || 'Done.'
    speech?.speak(null, fallback, voiceFor(detectLanguage(fallback, Object.keys(config.TTS_VOICES))))
    if (!finalMessage) finalMessage = fallback
  }

  emit({ type: 'response_end', text: finalMessage })
  emit({ type: 'response', text: finalMessage })
  // after the user's line, so the thread reads in order
  await userKept.then(() => keep('assistant', finalMessage))

  log.info(`+${lap()}ms LLM done (chunks=${spokenCount}, ${finalMessage.length}ch total)`)

  const ttsStart = Date.now()
  await speech?.drained()
  log.info(`tts drained +${Date.now() - ttsStart}ms | total +${lap()}ms`)
  session.finishTurn(turn.id)
}
