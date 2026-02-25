import type { ServerEvent, SessionState, TtsModelInfo, Personality, PersonalityInfo } from '~/shared/types'

export const PERSONALITIES: PersonalityInfo[] = [
  { id: 'glados', name: 'GLaDOS', description: 'Sardonic, cold, passive-aggressive' },
  { id: 'butler', name: 'Butler', description: 'Refined, polite British butler' },
  { id: 'professional', name: 'Professional', description: 'Crisp, efficient, no-nonsense' },
  { id: 'flirty', name: 'Flirty', description: 'Playful, charming, teasing' },
]

export interface Exchange {
  heard: string
  reply: string
  timestamp: number
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
let vadPhase: 'passive' | 'active' = 'passive'
let wakeCheckInFlight = false
let minWindowElapsed = false
let activeListeningTimer: ReturnType<typeof setTimeout> | null = null
let minWindowTimer: ReturnType<typeof setTimeout> | null = null

let ws: WebSocket | null = null
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let audioCtx: AudioContext | null = null
let pendingTranscript = ''
let isPlayingAudio = false
let recordingGen = 0
let lingerTimer: ReturnType<typeof setTimeout> | null = null
let userBubbleTimer: ReturnType<typeof setTimeout> | null = null

// Module-level audio energy — shared across composable re-invocations
const audioEnergy = ref(0)
let analyserRafId = 0

// Module-level mic energy — real-time input level during HEARING/LISTENING
const micEnergy = ref(0)
let micAnalyserCtx: AudioContext | null = null
let micAnalyserNode: AnalyserNode | null = null
let micSourceNode: MediaStreamAudioSourceNode | null = null
let micRafId = 0

function startMicEnergyLoop(): void {
  if (!micAnalyserNode) return
  const dataArray = new Uint8Array(micAnalyserNode.frequencyBinCount)
  function updateMicEnergy(): void {
    if (!micAnalyserNode) return
    micAnalyserNode.getByteFrequencyData(dataArray)
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] ?? 0
      sum += v * v
    }
    micEnergy.value = Math.sqrt(sum / dataArray.length) / 128
    micRafId = requestAnimationFrame(updateMicEnergy)
  }
  updateMicEnergy()
}

function stopMicEnergy(): void {
  if (micRafId) {
    cancelAnimationFrame(micRafId)
    micRafId = 0
  }
  micEnergy.value = 0
  if (micSourceNode) {
    micSourceNode.disconnect()
    micSourceNode = null
  }
  if (micAnalyserNode) {
    micAnalyserNode.disconnect()
    micAnalyserNode = null
  }
}

function connectMicAnalyser(stream: MediaStream): void {
  if (!micAnalyserCtx) micAnalyserCtx = new AudioContext()
  stopMicEnergy()
  micAnalyserNode = micAnalyserCtx.createAnalyser()
  micAnalyserNode.fftSize = 256
  micSourceNode = micAnalyserCtx.createMediaStreamSource(stream)
  micSourceNode.connect(micAnalyserNode)
  // Do NOT connect analyser to destination — we don't want to hear the mic
  startMicEnergyLoop()
}

export function useVoice() {
  const state = ref<SessionState>('IDLE')
  const isConnected = ref(false)
  const exchanges = ref<Exchange[]>([])
  const currentTranscript = ref('')
  const error = ref<string | null>(null)

  // Streaming LLM response
  const streamingText = ref('')
  const isStreaming = ref(false)

  // Bubble overlay — explicit visibility flag (texts cleared on next interaction, not during fade-out)
  const bubbleVisible = ref(false)
  const bubbleUserText = ref('')

  // Passive listening
  const passiveEnabled = ref(true)
  const isPassive = ref(false)
  const isHearing = ref(false)

  // True between wake word detection and first server state event — masks STT latency
  const isProcessingWake = ref(false)

  // TTS voice selection
  const availableModels = ref<TtsModelInfo[]>([])
  const selectedModel = ref('')
  const selectedVoice = ref('')

  // Personality selection
  const selectedPersonality = ref<Personality>(
    (typeof localStorage !== 'undefined' && localStorage.getItem('butler-personality') as Personality | null) || 'glados',
  )

  function startLingerTimer(): void {
    if (lingerTimer !== null) return
    lingerTimer = setTimeout(() => {
      lingerTimer = null
      bubbleVisible.value = false
    }, 3000)
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
      // Re-send stored voice preference on (re)connect
      if (selectedModel.value && selectedVoice.value) {
        ws?.send(JSON.stringify({ type: 'set_voice', model: selectedModel.value, voice: selectedVoice.value }))
      }
      // Re-send stored personality on (re)connect
      ws?.send(JSON.stringify({ type: 'set_personality', personality: selectedPersonality.value }))
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
        // Start linger when IDLE arrives without audio (e.g. TTS failed)
        if (event.state === 'IDLE' && bubbleVisible.value && !isPlayingAudio) {
          startLingerTimer()
        }
        break
      case 'transcript':
        pendingTranscript = event.text
        currentTranscript.value = event.text
        // Show user bubble — clear stale assistant text from previous interaction
        streamingText.value = ''
        bubbleUserText.value = event.text
        bubbleVisible.value = true
        // Auto-dismiss if no response follows (noise/discarded transcript)
        if (userBubbleTimer !== null) clearTimeout(userBubbleTimer)
        userBubbleTimer = setTimeout(() => {
          userBubbleTimer = null
          bubbleUserText.value = ''
          bubbleVisible.value = false
        }, 3000)
        break
      case 'response_start':
        // Cancel user bubble auto-dismiss — a response is coming
        if (userBubbleTimer !== null) {
          clearTimeout(userBubbleTimer)
          userBubbleTimer = null
        }
        // Cancel any pending linger timer — new response replaces old
        if (lingerTimer !== null) {
          clearTimeout(lingerTimer)
          lingerTimer = null
        }
        streamingText.value = ''
        isStreaming.value = true
        bubbleVisible.value = true
        break
      case 'response_delta':
        streamingText.value += event.text
        break
      case 'response_end':
        isStreaming.value = false
        // Empty text = server discarded (multi-round tool call) — reset
        if (!event.text) streamingText.value = ''
        break
      case 'response':
        if (pendingTranscript) {
          exchanges.value.push({ heard: pendingTranscript, reply: event.text, timestamp: Date.now() })
          pendingTranscript = ''
          currentTranscript.value = ''
        }
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

  async function playAudio(base64: string, _format: 'mp3' | 'wav'): Promise<void> {
    // Cancel any pending linger timer — new audio replaces old linger
    if (lingerTimer !== null) {
      clearTimeout(lingerTimer)
      lingerTimer = null
    }
    // Set flag BEFORE any async work — the server IDLE event can arrive
    // while decodeAudioData is running and must be blocked.
    isPlayingAudio = true
    try {
      if (!audioCtx) audioCtx = new AudioContext()
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const decoded = await audioCtx.decodeAudioData(bytes.buffer)
      const source = audioCtx.createBufferSource()
      source.buffer = decoded

      // Route through analyser for audio energy extraction
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyser.connect(audioCtx.destination)

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

      source.onended = () => {
        cancelAnimationFrame(analyserRafId)
        audioEnergy.value = 0
        isPlayingAudio = false
        state.value = 'IDLE'
        startLingerTimer()
      }
      source.start()
    } catch {
      cancelAnimationFrame(analyserRafId)
      audioEnergy.value = 0
      isPlayingAudio = false
      state.value = 'IDLE'
      startLingerTimer()
    }
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
      connectMicAnalyser(stream)
    } catch (err) {
      error.value = `Microphone access denied: ${err instanceof Error ? err.message : err}`
      setTimeout(() => { error.value = null }, 5000)
    }
  }

  function stopRecording(discard = false): void {
    recordingGen++ // invalidate any in-flight startRecording
    stopMicEnergy()
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
      if (wakeCheckInFlight || state.value !== 'IDLE') {
        isHearing.value = false
        stopMicEnergy()
        return
      }
      wakeCheckInFlight = true
      try {
        await checkWakeWord(audio)
      } finally {
        wakeCheckInFlight = false
        isHearing.value = false
        stopMicEnergy()
      }
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
          if (vadPhase === 'passive' && state.value === 'IDLE') {
            isHearing.value = true
            // Tap into the VAD's mic stream for real-time energy visualization
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vadStream = (vad as any)?._stream as MediaStream | undefined
            if (vadStream) connectMicAnalyser(vadStream)
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
    stopMicEnergy()
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
    if (passiveEnabled.value) void startPassiveListening()
  })

  onUnmounted(() => {
    ws?.close()
    stopPassiveListening()
  })

  // ── TTS voice selection ──────────────────────────────────────────────────────

  async function fetchVoiceModels(): Promise<void> {
    try {
      const data = await $fetch<{ models: TtsModelInfo[]; defaults: { model: string; voice: string } }>('/api/tts/voices')
      availableModels.value = data.models

      // Init from localStorage or server defaults
      const storedModel = localStorage.getItem('butler-tts-model')
      const storedVoice = localStorage.getItem('butler-tts-voice')
      if (storedModel && storedVoice) {
        selectedModel.value = storedModel
        selectedVoice.value = storedVoice
      } else {
        selectedModel.value = data.defaults.model
        selectedVoice.value = data.defaults.voice
      }
    } catch {
      // Non-critical — voice selector just stays empty
    }
  }

  function setVoice(model: string, voice: string): void {
    selectedModel.value = model
    selectedVoice.value = voice
    localStorage.setItem('butler-tts-model', model)
    localStorage.setItem('butler-tts-voice', voice)
    ws?.send(JSON.stringify({ type: 'set_voice', model, voice }))
  }

  function setPersonality(id: Personality): void {
    selectedPersonality.value = id
    localStorage.setItem('butler-personality', id)
    ws?.send(JSON.stringify({ type: 'set_personality', personality: id }))
  }

  // ── Misc ──────────────────────────────────────────────────────────────────────

  function sendPing(): void {
    ws?.send(JSON.stringify({ type: 'ping' }))
  }

  function clearHistory(): void {
    ws?.send(JSON.stringify({ type: 'clear_history' }))
    exchanges.value = []
    currentTranscript.value = ''
    pendingTranscript = ''
  }

  return {
    state,
    isConnected,
    exchanges,
    currentTranscript,
    error,
    streamingText: readonly(streamingText),
    isStreaming: readonly(isStreaming),
    bubbleVisible: readonly(bubbleVisible),
    bubbleUserText: readonly(bubbleUserText),
    passiveEnabled,
    isPassive,
    isHearing,
    isProcessingWake: readonly(isProcessingWake),
    audioEnergy: readonly(audioEnergy),
    micEnergy: readonly(micEnergy),
    availableModels: readonly(availableModels),
    selectedModel: readonly(selectedModel),
    selectedVoice: readonly(selectedVoice),
    startRecording,
    stopRecording,
    selectedPersonality: readonly(selectedPersonality),
    sendPing,
    clearHistory,
    setVoice,
    setPersonality,
  }
}
