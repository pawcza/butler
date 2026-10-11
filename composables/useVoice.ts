import type { BlockKind, ConversationThread, ServerEvent, SessionState, TtsModelInfo } from '~/shared/types'

/** A single persistent bubble in the chat log. `user` is the spoken transcript; the rest come from Hermes output items. */
export interface LogItem {
  id: string
  kind: 'user' | BlockKind
  tool?: string
  text: string
  streaming: boolean
}

const STORAGE_KEYS = {
  ttsModel: 'butler-tts-model',
  ttsVoice: 'butler-tts-voice',
  volume: 'butler-volume',
} as const
/** Hard cap on bubbles — bounds in-memory reactive cost on very long-running sessions. */
const MAX_LOG_ITEMS = 200

function loadVolume(): number {
  if (typeof localStorage === 'undefined') return 1
  const raw = localStorage.getItem(STORAGE_KEYS.volume)
  if (raw === null) return 1
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1
}

/** Convert Silero VAD Float32Array (16kHz mono) to 16-bit PCM WAV ArrayBuffer. */
function float32ToWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const numChannels = 1
  const bitsPerSample = 16
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  function writeStr(offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)                                               // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * numChannels * bitsPerSample) / 8, true) // byte rate
  view.setUint16(32, (numChannels * bitsPerSample) / 8, true)              // block align
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return buffer
}

// ── Module-level singletons — survive HMR / composable re-invocations ────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vad: any = null
let vadStarting = false
let vadPhase: 'passive' | 'active' | 'grace' = 'passive'
let graceTimer: ReturnType<typeof setTimeout> | null = null
let wakeCheckInFlight = false
let minWindowElapsed = false
let activeListeningTimer: ReturnType<typeof setTimeout> | null = null
let minWindowTimer: ReturnType<typeof setTimeout> | null = null

let ws: WebSocket | null = null
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let audioCtx: AudioContext | null = null
let gainNode: GainNode | null = null
let isPlayingAudio = false
/** FIFO queue of audio chunks received from the server while another one is still playing. */
const audioQueue: Array<{ base64: string; format: 'mp3' | 'wav' }> = []
let recordingGen = 0

// Module-level audio state — shared across composable re-invocations
const audioEnergy = ref(0)
const volume = ref(loadVolume())
let analyserRafId = 0

function ensureGain(ctx: AudioContext): GainNode {
  if (!gainNode || gainNode.context !== ctx) {
    gainNode = ctx.createGain()
    gainNode.connect(ctx.destination)
  }
  gainNode.gain.value = volume.value
  return gainNode
}


export function useVoice() {
  const state = ref<SessionState>('IDLE')
  const isConnected = ref(false)
  const error = ref<string | null>(null)

  // The open thread's bubbles. Every visit starts with a clean one; `?c=<id>` reopens a stored thread.
  const chatLog = ref<LogItem[]>([])
  /** conversation-api thread id; null until the first message of a fresh conversation opens one. */
  const conversationId = ref<string | null>(null)
  const isStreaming = ref(false)

  // Passive listening
  const passiveEnabled = ref(true)
  const isPassive = ref(false)

  // Grace period — conversational follow-up window after assistant speaks
  const isInGracePeriod = ref(false)

  // True between wake word detection and first server state event — masks STT latency
  const isProcessingWake = ref(false)

  // TTS voice selection
  const availableModels = ref<TtsModelInfo[]>([])
  const selectedModel = ref(
    (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEYS.ttsModel)) || '',
  )
  const selectedVoice = ref(
    (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEYS.ttsVoice)) || '',
  )

  function startGracePeriod(): void {
    if (!vad || !isPassive.value) return
    cancelGracePeriod()
    vadPhase = 'grace'
    isInGracePeriod.value = true
    graceTimer = setTimeout(() => {
      graceTimer = null
      vadPhase = 'passive'
      isInGracePeriod.value = false
    }, 10_000)
  }

  function cancelGracePeriod(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    if (vadPhase === 'grace') vadPhase = 'passive'
    isInGracePeriod.value = false
  }

  // ── Preference re-sync ──────────────────────────────────────────────────────

  function resyncPreferences(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (selectedModel.value && selectedVoice.value) {
      ws.send(JSON.stringify({ type: 'set_voice', model: selectedModel.value, voice: selectedVoice.value }))
    }
  }

  function pushLogItem(item: LogItem): void {
    chatLog.value.push(item)
    const excess = chatLog.value.length - MAX_LOG_ITEMS
    if (excess > 0) chatLog.value.splice(0, excess)
  }

  /** Blocks usually arrive / update at the tail of the log, so searching right-to-left is O(1) in practice. */
  function findBlock(blockId: string): LogItem | undefined {
    return chatLog.value.findLast((b) => b.id === blockId)
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
      resyncPreferences()
      // the server's session is per connection: tell a fresh one which thread we're in
      syncConversation()
    }
    ws.onclose = () => { isConnected.value = false }
    ws.onerror = () => { error.value = 'WebSocket connection failed' }
    ws.onmessage = (ev: MessageEvent) => handleMessage(ev)
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
        // Don't go IDLE while audio is still playing — stay in SPEAKING
        if (event.state === 'IDLE' && isPlayingAudio) break
        state.value = event.state
        break
      case 'transcript':
        audioQueue.length = 0
        pushLogItem({
          id: event.id,
          kind: 'user',
          text: event.text,
          streaming: false,
        })
        break
      case 'response_start':
        isStreaming.value = true
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
        void playAudio(event.data, event.format)
        break
      case 'error':
        error.value = event.message
        setTimeout(() => { error.value = null }, 5000)
        break
    }
  }

  // ── Audio playback ────────────────────────────────────────────────────────────

  async function playAudio(base64: string, format: 'mp3' | 'wav'): Promise<void> {
    // Queue if something's already playing — the current clip's onended will drain us.
    if (isPlayingAudio) {
      audioQueue.push({ base64, format })
      return
    }
    // Set flag BEFORE any async work — the server IDLE event can arrive
    // while decodeAudioData is running and must be blocked.
    isPlayingAudio = true
    try {
      await playOne(base64)
    } catch {
      // swallowed — finishedPlaying below still runs
    }
    while (audioQueue.length > 0) {
      const next = audioQueue.shift()
      if (!next) break
      try {
        await playOne(next.base64)
      } catch {
        // keep draining on error
      }
    }
    cancelAnimationFrame(analyserRafId)
    audioEnergy.value = 0
    isPlayingAudio = false
    state.value = 'IDLE'
  }

  function playOne(base64: string): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        if (!audioCtx) audioCtx = new AudioContext()
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        audioCtx.decodeAudioData(bytes.buffer).then((decoded) => {
          const ctx = audioCtx
          if (!ctx) { resolve(); return }
          const source = ctx.createBufferSource()
          source.buffer = decoded

          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          // source → analyser → gain → destination
          // Analyser sits before gain so visualizations stay consistent regardless of volume.
          source.connect(analyser)
          analyser.connect(ensureGain(ctx))

          const dataArray = new Uint8Array(analyser.frequencyBinCount)
          function updateEnergy() {
            analyser.getByteFrequencyData(dataArray)
            let sum = 0
            for (let i = 0; i < dataArray.length; i++) {
              const v = dataArray[i] ?? 0
              sum += v * v
            }
            audioEnergy.value = Math.sqrt(sum / dataArray.length) / 128
            analyserRafId = requestAnimationFrame(updateEnergy)
          }
          updateEnergy()

          source.onended = () => { resolve() }
          source.start()
        }).catch(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  function playAckSound(): void {
    console.log('[vad] playing ack sound')
    new Audio('/ack-sound.mp3').play().catch((err) => {
      console.warn('[vad] ack sound blocked:', err)
    })
  }

  // ── Manual recording ─────────────────────────────────────────────────────────

  async function startRecording(silent = false): Promise<void> {
    if (mediaRecorder?.state === 'recording') return
    cancelGracePeriod()
    if (!silent) {
      playAckSound()
      if (vad) vad.pause()
    }
    const gen = ++recordingGen
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // If stopRecording was called while awaiting mic access, discard
      if (gen !== recordingGen) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      audioChunks = []
      mediaRecorder = new MediaRecorder(stream)
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data) }
      mediaRecorder.start()
    } catch (err) {
      error.value = `Microphone access denied: ${err instanceof Error ? err.message : err}`
      setTimeout(() => { error.value = null }, 5000)
    }
  }

  function stopRecording(discard = false): void {
    recordingGen++ // invalidate any in-flight startRecording
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return
    if (discard) {
      mediaRecorder.onstop = null
      mediaRecorder.stop()
      mediaRecorder.stream.getTracks().forEach((t) => t.stop())
      if (vad && isPassive.value) vad.start()
      return
    }
    if (!ws) return
    const currentWs = ws
    mediaRecorder.onstop = async () => {
      if (!currentWs) return
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      currentWs.send(await blob.arrayBuffer())
    }
    mediaRecorder.stop()
    mediaRecorder.stream.getTracks().forEach((t) => t.stop())
    if (vad && isPassive.value) vad.start()
  }

  // ── Passive VAD + wake word ───────────────────────────────────────────────────

  async function handleSpeechEnd(audio: Float32Array): Promise<void> {
    console.log('[vad] onSpeechEnd fired — phase:', vadPhase, '| samples:', audio.length, '| inFlight:', wakeCheckInFlight, '| state:', state.value)
    if (vadPhase === 'passive') {
      if (wakeCheckInFlight || state.value !== 'IDLE') return
      wakeCheckInFlight = true
      try {
        await checkWakeWord(audio)
      } finally {
        wakeCheckInFlight = false
      }
    } else if (vadPhase === 'grace') {
      // Grace period follow-up — send audio directly, skip wake word
      cancelGracePeriod()
      const wav = float32ToWav(audio)
      ws?.send(wav)
      isProcessingWake.value = true
    } else if (vadPhase === 'active' && minWindowElapsed) {
      triggerActiveStop()
    }
  }

  async function checkWakeWord(audio: Float32Array): Promise<void> {
    const wav = float32ToWav(audio)
    const blob = new Blob([wav], { type: 'audio/wav' })
    const form = new FormData()
    form.append('audio', blob, 'wake.wav')

    try {
      console.log('[vad] posting to /api/wakeword — blob size:', blob.size)
      const result = await $fetch<{ heard: string }>('/api/wakeword', {
        method: 'POST',
        body: form,
      })
      console.log('[vad] heard:', JSON.stringify(result.heard))

      const lower = result.heard.toLowerCase()
      const wakeIdx = lower.indexOf('home')
      if (wakeIdx === -1) return

      // Extract everything after the wake word, stripping leading punctuation/spaces
      const commandText = result.heard.slice(wakeIdx + 'home'.length).replace(/^[,.\s!?]+/, '').trim()
      console.log('[vad] command text:', JSON.stringify(commandText))

      playAckSound()
      isProcessingWake.value = true

      if (commandText.length > 2) {
        // Alexa-style: command is in the same utterance — send directly to pipeline
        const payload = JSON.stringify({ type: 'command', text: commandText })
        console.log('[vad] sending WS command, readyState:', ws?.readyState, 'payload:', payload)
        ws?.send(payload)
      } else {
        // Bare wake word — open active listening window
        await triggerActiveStart()
      }
    } catch (err) {
      isProcessingWake.value = false
      console.warn('[vad] wakeword check failed:', err)
    }
  }

  async function triggerActiveStart(): Promise<void> {
    console.log('[vad] wake word matched — starting active listening')
    vadPhase = 'active'
    minWindowElapsed = false

    if (vad) vad.pause()
    await startRecording(true)

    // Minimum grace window — don't close on silence before this elapses
    minWindowTimer = setTimeout(() => {
      minWindowElapsed = true
    }, 1500)

    // Hard maximum — send regardless of VAD after 10s
    activeListeningTimer = setTimeout(() => {
      if (vadPhase === 'active') triggerActiveStop()
    }, 10_000)
  }

  function triggerActiveStop(): void {
    vadPhase = 'passive'

    if (minWindowTimer !== null) {
      clearTimeout(minWindowTimer)
      minWindowTimer = null
    }
    if (activeListeningTimer !== null) {
      clearTimeout(activeListeningTimer)
      activeListeningTimer = null
    }

    stopRecording()
    if (vad) vad.start()
  }

  async function startPassiveListening(): Promise<void> {
    if (vad || vadStarting) return // already running or initializing
    vadStarting = true
    try {
      // Dynamic import — client-side only; never runs on server
      const { MicVAD } = await import('@ricky0123/vad-web')
      vad = await MicVAD.new({
        baseAssetPath: '/_vad/',
        onnxWASMBasePath: '/_vad/',
        model: 'v5',
        minSpeechMs: 30,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ortConfig: (ort: any) => { ort.env.wasm.numThreads = 1 },
        onSpeechStart: () => {
          // Reset grace timer — user is speaking, give them a fresh 10s after they finish
          if (vadPhase === 'grace' && graceTimer !== null) {
            clearTimeout(graceTimer)
            graceTimer = null
          }
        },
        onSpeechEnd: (audio: Float32Array) => {
          void handleSpeechEnd(audio)
        },
      })
      await vad.start()
      isPassive.value = true
      console.log('[vad] passive listening started')
    } catch (err) {
      error.value = `Passive listening unavailable: ${err instanceof Error ? err.message : err}`
      setTimeout(() => { error.value = null }, 5000)
      passiveEnabled.value = false
    } finally {
      vadStarting = false
    }
  }

  function stopPassiveListening(): void {
    if (!vad) return
    vad.pause()
    vad.destroy()
    vad = null
    isPassive.value = false
    vadPhase = 'passive'
  }

  watch(passiveEnabled, (enabled) => {
    if (enabled) {
      void startPassiveListening()
    } else {
      stopPassiveListening()
    }
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onMounted(() => {
    connect()
    void fetchVoiceModels()
    const reopen = new URL(window.location.href).searchParams.get('c')
    if (reopen) void openConversation(reopen)
    if (passiveEnabled.value) void startPassiveListening()
  })

  onUnmounted(() => {
    ws?.close()
    stopPassiveListening()
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

  // ── TTS voice selection ──────────────────────────────────────────────────────

  async function fetchVoiceModels(): Promise<void> {
    try {
      const data = await $fetch<{ models: TtsModelInfo[]; defaults: { model: string; voice: string } }>('/api/tts/voices')
      availableModels.value = data.models

      // Init from localStorage or server defaults
      const storedModel = localStorage.getItem(STORAGE_KEYS.ttsModel)
      const storedVoice = localStorage.getItem(STORAGE_KEYS.ttsVoice)
      if (storedModel && storedVoice) {
        selectedModel.value = storedModel
        selectedVoice.value = storedVoice
      } else {
        selectedModel.value = data.defaults.model
        selectedVoice.value = data.defaults.voice
      }

      // Re-send preferences now that voice refs are populated — covers the
      // race where ws.onopen fired before this fetch resolved.
      resyncPreferences()
    } catch {
      // Non-critical — voice selector just stays empty
    }
  }

  function setVoice(model: string, voice: string): void {
    selectedModel.value = model
    selectedVoice.value = voice
    localStorage.setItem(STORAGE_KEYS.ttsModel, model)
    localStorage.setItem(STORAGE_KEYS.ttsVoice, voice)
    ws?.send(JSON.stringify({ type: 'set_voice', model, voice }))
  }

  // ── Misc ──────────────────────────────────────────────────────────────────────

  function sendPing(): void {
    ws?.send(JSON.stringify({ type: 'ping' }))
  }

  function setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v))
    volume.value = clamped
    if (gainNode) gainNode.gain.value = clamped
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
    ws.send(JSON.stringify({ type: 'command', text: trimmed }))
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
    audioEnergy: readonly(audioEnergy),
    availableModels: readonly(availableModels),
    selectedModel: readonly(selectedModel),
    selectedVoice: readonly(selectedVoice),
    startRecording,
    stopRecording,
    isInGracePeriod: readonly(isInGracePeriod),
    sendPing,
    sendCommand,
    setVoice,
    volume: readonly(volume),
    setVolume,
  }
}
