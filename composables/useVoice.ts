import type { MicVAD } from '@ricky0123/vad-web'
import type { BlockKind, ConversationThread, ServerEvent, SessionState } from '~/shared/types'
import { MAX_JSON_FRAME_BYTES, PCM_SAMPLE_RATE, PRE_ROLL_RING_SECONDS, encodeAudioFrame } from '~/shared/audio'
import { PcmRing } from '~/utils/pcm'
import { float32ToWav } from '~/utils/wav'
import { createSpeechPlayer } from '~/utils/speech-player'
import pcmCaptureUrl from '~/worklets/pcm-capture.ts?worker&url'

/** A single persistent bubble in the chat log. `user` is the spoken transcript; the rest are response blocks. */
export interface LogItem {
  id: string
  kind: 'user' | BlockKind
  tool?: string
  text: string
  streaming: boolean
}

const STORAGE_KEYS = {
  volume: 'butler-volume',
} as const
/** Left behind by the voice picker, which is gone: the voice is the server's setting. */
const STALE_STORAGE_KEYS = ['butler-tts-model', 'butler-tts-voice']
/** Hard cap on bubbles — bounds in-memory reactive cost on very long-running sessions. */
const MAX_LOG_ITEMS = 200
/** Audio from just before a press goes out with it, so a quick start keeps its first word. */
const PRE_ROLL_SAMPLES = PCM_SAMPLE_RATE * 0.6
/**
 * After a bare wake word, audio from this long before the VAD reported its end. That stretch is
 * the VAD's trailing silence, so it only covers the VAD running a little behind the microphone.
 */
const WAKE_PRE_ROLL_MARGIN = PCM_SAMPLE_RATE * 0.25
/** A push-to-talk release keeps streaming this long, so the last word is never clipped. */
const RELEASE_TAIL_MS = 200
/** The vad-web defaults, for the one stream the VAD and the capture share. */
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
}

function loadVolume(): number {
  if (typeof localStorage === 'undefined') return 1
  const raw = localStorage.getItem(STORAGE_KEYS.volume)
  if (raw === null) return 1
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1
}

// ── Module-level singletons — survive HMR / composable re-invocations ────────
let vad: MicVAD | null = null
let vadStarting = false
let vadPhase: 'passive' | 'active' = 'passive'
let wakeCheckInFlight = false
let minWindowElapsed = false
let activeListeningTimer: ReturnType<typeof setTimeout> | null = null
let minWindowTimer: ReturnType<typeof setTimeout> | null = null
let releaseTailTimer: ReturnType<typeof setTimeout> | null = null

let ws: WebSocket | null = null
// One microphone stream, opened once and kept open. The PCM worklet and the VAD both read it.
let micStream: MediaStream | null = null
let micCtx: AudioContext | null = null
let micOpening: Promise<boolean> | null = null
/** Stops the gesture listeners that keep `micCtx` running. */
let micGestureCleanup: (() => void) | null = null
/** The latest seconds of microphone audio as 16 kHz PCM, for pre-roll. */
const ring = new PcmRing(PCM_SAMPLE_RATE * PRE_ROLL_RING_SECONDS)
/** Microphone frames are streaming to the server, between `audio_start` and `audio_end`. */
const capturing = ref(false)
/**
 * `audio_end` is sent but the server hasn't answered with a state event yet. The server is still
 * IDLE as far as this client knows, so a capture opened now would be refused as busy.
 */
let awaitingServerState = false
/** The capture is closed but its final transcript hasn't arrived; its partials still count. */
let awaitingFinal = false
/** Id of the partial transcript bubble being shown, if any. */
let liveTranscriptId: string | null = null
/** Ring position of the last moment the client was busy: capturing, playing, or in a turn. */
let lastBusyAt = -1
/** Ring positions of the VAD's latest speech start and end. */
let speechStartedAt = 0
let lastSpeechEndAt = 0
let vadSpeaking = false
let pressGen = 0
/** Last state the server reported. Playback can end while a tool loop is still running. */
let serverState: SessionState = 'IDLE'

// Module-level audio state — shared across composable re-invocations
const audioEnergy = ref(0)
const volume = ref(loadVolume())

export function useVoice() {
  const state = ref<SessionState>('IDLE')
  const isConnected = ref(false)
  const error = ref<string | null>(null)

  // The open thread's bubbles. Every visit starts with a clean one; `?c=<id>` reopens a stored thread.
  const chatLog = ref<LogItem[]>([])
  /** Thread id; null until the first message of a fresh conversation opens one. */
  const conversationId = ref<string | null>(null)
  const isStreaming = ref(false)

  // Passive listening
  const passiveEnabled = ref(true)
  const isPassive = ref(false)

  // True between a wake word with its command attached and the first server state event — masks STT latency
  const isProcessingWake = ref(false)
  // True while the window after a bare wake word is open and the microphone is streaming
  const isWakeListening = ref(false)

  // ── Speech playback ─────────────────────────────────────────────────────────

  const player = createSpeechPlayer({
    textOf: (blockId) => chatLog.value.findLast((b) => b.id === blockId)?.text,
    volume: () => volume.value,
    onEnergy: (energy) => { audioEnergy.value = energy },
    onIdle: () => {
      state.value = serverState
      // between two sentences the highlight stays; once the turn's speech is over it goes
      if (serverState !== 'SPEAKING') player.clearProgress()
    },
  })
  /** Butler is speaking, or has speech queued or on its way. */
  const isSpeaking = computed(() => player.active.value || state.value === 'SPEAKING')

  function pushLogItem(item: LogItem): void {
    chatLog.value.push(item)
    const excess = chatLog.value.length - MAX_LOG_ITEMS
    if (excess > 0) chatLog.value.splice(0, excess)
  }

  /** Blocks usually arrive / update at the tail of the log, so searching right-to-left is O(1) in practice. */
  function findBlock(blockId: string): LogItem | undefined {
    return chatLog.value.findLast((b) => b.id === blockId)
  }

  function removeLogItem(id: string): void {
    const index = chatLog.value.findLastIndex((b) => b.id === id)
    if (index >= 0) chatLog.value.splice(index, 1)
  }

  function showError(message: string): void {
    error.value = message
    setTimeout(() => { error.value = null }, 5000)
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  function connect(): void {
    // Close stale connection (HMR reload, re-mount, etc.)
    if (ws) {
      ws.onclose = null // prevent isConnected flip
      ws.close()
      ws = null
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      isConnected.value = true
      // the server's session is per connection: tell a fresh one which thread we're in
      syncConversation()
    }
    ws.onclose = () => {
      isConnected.value = false
      // the server dropped any capture with the socket
      resetCapture()
    }
    ws.onerror = () => { error.value = 'WebSocket connection failed' }
    ws.onmessage = (ev: MessageEvent) => handleMessage(ev)
  }

  /** The server has no capture of ours: forget everything about it. */
  function resetCapture(): void {
    capturing.value = false
    awaitingFinal = false
    awaitingServerState = false
    if (releaseTailTimer !== null) {
      clearTimeout(releaseTailTimer)
      releaseTailTimer = null
    }
    endWakeWindow()
    if (liveTranscriptId !== null) removeLogItem(liveTranscriptId)
    liveTranscriptId = null
  }

  function handleMessage(ev: MessageEvent): void {
    let event: ServerEvent
    try {
      event = JSON.parse(ev.data as string) as ServerEvent
    } catch {
      return
    }

    switch (event.type) {
      case 'state':
        isProcessingWake.value = false
        serverState = event.state
        awaitingServerState = false
        if (event.state === 'LISTENING' && capturing.value) {
          // the server closed the capture itself (length limit) and is answering it. Other states
          // can be late news from the turn this capture interrupted.
          capturing.value = false
          awaitingFinal = true
          endWakeWindow()
        }
        if (event.state === 'IDLE') awaitingFinal = false
        // Don't go IDLE while audio is still playing — stay in SPEAKING
        if (event.state === 'IDLE' && player.active.value) break
        state.value = event.state
        if (!player.active.value && event.state !== 'SPEAKING') player.clearProgress()
        break
      case 'transcript_partial': {
        // late partials of a cancelled utterance are ignored
        if (!capturing.value && !awaitingFinal) break
        liveTranscriptId = event.id
        const item = findBlock(event.id)
        if (item) item.text = event.text
        else pushLogItem({ id: event.id, kind: 'user', text: event.text, streaming: true })
        break
      }
      case 'transcript': {
        player.stop()
        awaitingFinal = false
        liveTranscriptId = null
        const item = findBlock(event.id)
        if (item) {
          item.text = event.text
          item.streaming = false
        } else {
          pushLogItem({ id: event.id, kind: 'user', text: event.text, streaming: false })
        }
        break
      }
      case 'transcript_discarded':
        awaitingFinal = false
        if (event.id === liveTranscriptId) liveTranscriptId = null
        removeLogItem(event.id)
        break
      case 'response_start':
        isStreaming.value = true
        player.accept()
        break
      case 'block_start': {
        const item: LogItem = {
          id: event.blockId,
          kind: event.kind,
          text: '',
          streaming: true,
        }
        if (event.tool !== undefined) item.tool = event.tool
        pushLogItem(item)
        break
      }
      case 'block_delta': {
        const item = findBlock(event.blockId)
        if (item) item.text += event.text
        break
      }
      case 'block_end': {
        const item = findBlock(event.blockId)
        if (item) {
          item.text = event.text
          item.streaming = false
        }
        break
      }
      case 'block_remove': {
        const at = chatLog.value.findLastIndex((b) => b.id === event.blockId)
        if (at !== -1) chatLog.value.splice(at, 1)
        break
      }
      case 'response_end':
        isStreaming.value = false
        break
      case 'response':
        break
      case 'conversation':
        conversationId.value = event.conversation.id
        setUrlConversation(event.conversation.id)
        break
      case 'audio':
        player.enqueue({ data: event.data, format: event.format, ...(event.block ? { block: event.block } : {}) })
        break
      case 'capture_refused':
        resetCapture()
        break
      case 'error':
        error.value = event.message
        setTimeout(() => { error.value = null }, 5000)
        break
    }
  }

  // ── Stop and pause ────────────────────────────────────────────────────────────

  /** Silences butler now and tells the server to drop the rest of this turn's speech. */
  function stopSpeaking(): void {
    player.stop()
    state.value = serverState
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop_speech' }))
  }

  function playAckSound(): void {
    // Autoplay policy can block this before the first user gesture; the sound is optional.
    new Audio('/ack-sound.mp3').play().catch(() => {})
  }

  // ── Microphone ───────────────────────────────────────────────────────────────

  /** Opens the microphone once; every later call reuses it. Resolves to whether it is open. */
  async function ensureMic(): Promise<boolean> {
    if (micStream && micCtx) return true
    micOpening ??= openMic()
    try {
      return await micOpening
    } finally {
      micOpening = null
    }
  }

  async function openMic(): Promise<boolean> {
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
      ctx = new AudioContext()
      await ctx.audioWorklet.addModule(pcmCaptureUrl)
      const node = new AudioWorkletNode(ctx, 'pcm-capture')
      node.port.onmessage = (ev: MessageEvent<Int16Array>) => onMicFrame(ev.data)
      ctx.createMediaStreamSource(stream).connect(node)
      micStream = stream
      micCtx = ctx
      micGestureCleanup = keepRunning(ctx)
      return true
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      showError(`Microphone unavailable: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }

  /**
   * A context created with no user gesture behind it (the wake word flow) can start suspended, and a
   * suspended one never runs the capture worklet. Try now, and retry on every pointer or key press
   * while it is not running. Returns the cleanup.
   */
  function keepRunning(ctx: AudioContext): () => void {
    const wake = (): void => {
      if (ctx.state !== 'running') void ctx.resume().catch(() => {})
    }
    const events = ['pointerdown', 'keydown'] as const
    for (const name of events) window.addEventListener(name, wake, true)
    wake()
    return () => { for (const name of events) window.removeEventListener(name, wake, true) }
  }

  function releaseMic(): void {
    closeCapture(true)
    micGestureCleanup?.()
    micGestureCleanup = null
    micStream?.getTracks().forEach((t) => t.stop())
    void micCtx?.close()
    micStream = null
    micCtx = null
  }

  function isBusy(): boolean {
    return capturing.value || awaitingFinal || player.active.value || state.value !== 'IDLE'
      || isProcessingWake.value || vadPhase === 'active'
  }

  /** One ~100 ms frame of 16 kHz PCM from the worklet. */
  function onMicFrame(pcm: Int16Array): void {
    ring.write(pcm)
    if (isBusy()) lastBusyAt = ring.position
    if (capturing.value && ws?.readyState === WebSocket.OPEN) ws.send(encodeAudioFrame(pcm))
  }

  // ── Capture: streaming one utterance to the server ───────────────────────────

  /** Starts streaming, beginning with the ring buffer from `from` onwards. */
  function openCapture(from: number): boolean {
    if (capturing.value || awaitingServerState || !ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: 'audio_start' }))
    capturing.value = true
    awaitingFinal = false
    const preRoll = ring.readSince(from)
    if (preRoll.length > 0) ws.send(encodeAudioFrame(preRoll))
    return true
  }

  /** Ends the capture: the server answers it, or with `cancel` drops it. */
  function closeCapture(cancel: boolean): void {
    endWakeWindow()
    if (releaseTailTimer !== null) {
      clearTimeout(releaseTailTimer)
      releaseTailTimer = null
    }
    if (!capturing.value) return
    capturing.value = false
    awaitingFinal = !cancel
    if (cancel && liveTranscriptId !== null) {
      removeLogItem(liveTranscriptId)
      liveTranscriptId = null
    }
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: cancel ? 'audio_cancel' : 'audio_end' }))
      // the server answers `audio_end` with a state event; until then no new capture may open
      if (!cancel) awaitingServerState = true
    }
  }

  /** Push-to-talk pressed. The first press opens the microphone if passive listening hasn't. */
  async function startTalking(): Promise<void> {
    if (capturing.value) {
      // pressed again inside the release tail: the same capture goes on, the tail no longer ends it
      if (releaseTailTimer !== null) {
        clearTimeout(releaseTailTimer)
        releaseTailTimer = null
      }
      return
    }
    if (awaitingServerState) return
    playAckSound()
    const gen = ++pressGen
    if (!(await ensureMic())) return
    // released while the microphone was opening
    if (gen !== pressGen) return
    void micCtx?.resume()
    openCapture(ring.position - PRE_ROLL_SAMPLES)
  }

  /**
   * Push-to-talk released; `discard` drops a press too short to mean anything. A real release keeps
   * streaming for a moment first, so the last word isn't clipped.
   */
  function stopTalking(discard = false): void {
    pressGen++
    if (discard || !capturing.value) {
      closeCapture(discard)
      return
    }
    releaseTailTimer ??= setTimeout(() => closeCapture(false), RELEASE_TAIL_MS)
  }

  // ── Passive VAD + wake word ───────────────────────────────────────────────────

  async function handleSpeechEnd(audio: Float32Array): Promise<void> {
    const startedAt = speechStartedAt
    const endedAt = ring.position
    vadSpeaking = false
    lastSpeechEndAt = endedAt
    if (vadPhase === 'active') {
      if (minWindowElapsed) closeCapture(false)
      return
    }
    // Speech that overlapped a capture, playback or a turn is never a wake word: that is
    // butler's own voice or the user's command.
    if (wakeCheckInFlight || isBusy() || lastBusyAt >= startedAt) return
    wakeCheckInFlight = true
    try {
      await checkWakeWord(audio, endedAt)
    } finally {
      wakeCheckInFlight = false
    }
  }

  /** `endedAt` is the ring position where the wake utterance ended. */
  async function checkWakeWord(audio: Float32Array, endedAt: number): Promise<void> {
    const wav = float32ToWav(audio)
    const blob = new Blob([wav], { type: 'audio/wav' })
    const form = new FormData()
    form.append('audio', blob, 'wake.wav')

    try {
      const { command } = await $fetch<{ command: string | null }>('/api/wakeword', {
        method: 'POST',
        body: form,
      })
      if (command === null) return

      playAckSound()

      if (command.length > 2) {
        // Alexa-style: command is in the same utterance — send directly to pipeline
        isProcessingWake.value = true
        ws?.send(JSON.stringify({ type: 'command', text: command }))
      } else {
        // Bare wake word: listen for the command, which may already be under way
        triggerActiveStart(endedAt)
      }
    } catch {
      // Passive listening keeps going; the next utterance gets a fresh attempt.
      isProcessingWake.value = false
    }
  }

  /**
   * Opens the listening window after a bare wake word. Its audio starts where the wake word
   * ended (`wakeEndedAt`), since the check takes a while and the user often speaks during it.
   * The VAD keeps running, so the end of speech closes the window.
   */
  function triggerActiveStart(wakeEndedAt: number): void {
    if (!openCapture(wakeEndedAt - WAKE_PRE_ROLL_MARGIN)) return
    vadPhase = 'active'
    isWakeListening.value = true
    minWindowElapsed = false

    // Minimum grace window — don't close on silence before this elapses
    minWindowTimer = setTimeout(() => {
      minWindowElapsed = true
      // the whole command may have been said while the wake word was being checked
      if (!vadSpeaking && lastSpeechEndAt > wakeEndedAt) closeCapture(false)
    }, 1500)

    // Hard maximum — send regardless of VAD after 10s
    activeListeningTimer = setTimeout(() => closeCapture(false), 10_000)
  }

  function endWakeWindow(): void {
    vadPhase = 'passive'
    isWakeListening.value = false
    if (minWindowTimer !== null) {
      clearTimeout(minWindowTimer)
      minWindowTimer = null
    }
    if (activeListeningTimer !== null) {
      clearTimeout(activeListeningTimer)
      activeListeningTimer = null
    }
  }

  async function startPassiveListening(): Promise<void> {
    if (vad || vadStarting) return // already running or initializing
    vadStarting = true
    try {
      if (!(await ensureMic()) || !micStream || !micCtx) {
        passiveEnabled.value = false
        return
      }
      const stream = micStream
      // Dynamic import — client-side only; never runs on server
      const { MicVAD } = await import('@ricky0123/vad-web')
      vad = await MicVAD.new({
        baseAssetPath: '/_vad/',
        onnxWASMBasePath: '/_vad/',
        model: 'v5',
        minSpeechMs: 30,
        ortConfig: (ort) => { ort.env.wasm.numThreads = 1 },
        // The VAD reads the shared microphone; pausing or destroying it must never stop the tracks.
        audioContext: micCtx,
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        onSpeechStart: () => {
          vadSpeaking = true
          speechStartedAt = ring.position
        },
        onVADMisfire: () => { vadSpeaking = false },
        onSpeechEnd: (audio: Float32Array) => {
          void handleSpeechEnd(audio)
        },
      })
      await vad.start()
      isPassive.value = true
    } catch (err) {
      showError(`Passive listening unavailable: ${err instanceof Error ? err.message : err}`)
      passiveEnabled.value = false
    } finally {
      vadStarting = false
    }
  }

  function stopPassiveListening(): void {
    if (vadPhase === 'active') closeCapture(false)
    if (!vad) return
    vad.pause()
    vad.destroy()
    vad = null
    isPassive.value = false
  }

  watch(passiveEnabled, (enabled) => {
    if (enabled) {
      void startPassiveListening()
    } else {
      stopPassiveListening()
    }
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onMounted(async () => {
    for (const key of STALE_STORAGE_KEYS) localStorage.removeItem(key)
    connect()
    const reopen = new URL(window.location.href).searchParams.get('c')
    if (reopen) void openConversation(reopen)
    const speechRecognition = await fetchSpeechRecognition()
    // Without speech recognition there is nothing to do with the mic, so don't ask for it.
    if (passiveEnabled.value && speechRecognition) void startPassiveListening()
  })

  onUnmounted(() => {
    ws?.close()
    stopPassiveListening()
    releaseMic()
  })

  // ── Conversations ────────────────────────────────────────────────────────────

  function syncConversation(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'set_conversation', id: conversationId.value }))
  }

  function setUrlConversation(id: string | null): void {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('c', id)
    else url.searchParams.delete('c')
    window.history.replaceState(window.history.state, '', url)
  }

  /** Start clean: the next message opens a new thread. */
  function newConversation(): boolean {
    if (state.value !== 'IDLE') return false
    chatLog.value = []
    conversationId.value = null
    setUrlConversation(null)
    syncConversation()
    return true
  }

  /** Reopen a stored thread and continue it. A thread that's gone falls back to a clean one. */
  async function openConversation(id: string): Promise<boolean> {
    if (state.value !== 'IDLE') return false
    try {
      const thread = await $fetch<ConversationThread>(`/api/conversations/${encodeURIComponent(id)}`)
      chatLog.value = thread.items.map((m) => ({
        id: m.id,
        kind: m.role === 'user' ? 'user' : 'message',
        text: m.content,
        streaming: false,
      }))
      conversationId.value = thread.conversation.id
      setUrlConversation(thread.conversation.id)
      syncConversation()
      return true
    } catch {
      newConversation()
      return false
    }
  }

  /** The open thread was deleted elsewhere in the UI: drop back to a clean one. */
  function forgetConversation(id: string): void {
    if (conversationId.value === id) newConversation()
  }

  // ── Server capabilities ──────────────────────────────────────────────────────

  /** Resolves to whether the server has speech recognition configured. */
  async function fetchSpeechRecognition(): Promise<boolean> {
    try {
      return (await $fetch<{ stt: boolean }>('/api/capabilities')).stt
    } catch {
      // Non-critical: assume it is there, and let the first capture say otherwise.
      return true
    }
  }

  // ── Misc ──────────────────────────────────────────────────────────────────────

  function setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v))
    volume.value = clamped
    player.applyVolume()
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.volume, String(clamped))
    }
  }

  /** Send a typed command through the same pipeline as a voice transcription. */
  function sendCommand(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (state.value !== 'IDLE') return false
    const frame = JSON.stringify({ type: 'command', text: trimmed })
    if (new TextEncoder().encode(frame).length > MAX_JSON_FRAME_BYTES) {
      showError('That message is too long to send')
      return false
    }
    ws.send(frame)
    return true
  }

  return {
    state,
    isConnected,
    error,
    chatLog: readonly(chatLog),
    conversationId: readonly(conversationId),
    newConversation,
    openConversation,
    forgetConversation,
    isStreaming: readonly(isStreaming),
    passiveEnabled,
    isPassive,
    isProcessingWake: readonly(isProcessingWake),
    isWakeListening: readonly(isWakeListening),
    isCapturing: readonly(capturing),
    audioEnergy: readonly(audioEnergy),
    isSpeaking,
    isPlaying: player.active,
    isPaused: player.paused,
    speechProgress: player.progress,
    stopSpeaking,
    pauseSpeaking: player.pause,
    resumeSpeaking: player.resume,
    startTalking,
    stopTalking,
    sendCommand,
    volume: readonly(volume),
    setVolume,
  }
}
