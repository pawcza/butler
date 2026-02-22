import type { ServerEvent, SessionState } from '~/shared/types'

export interface Exchange {
  heard: string
  reply: string
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

export function useVoice() {
  const state = ref<SessionState>('IDLE')
  const isConnected = ref(false)
  const exchanges = ref<Exchange[]>([])
  const currentTranscript = ref('')
  const error = ref<string | null>(null)

  // Passive listening
  const passiveEnabled = ref(true)
  const isPassive = ref(false)

  let ws: WebSocket | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: Blob[] = []
  let audioCtx: AudioContext | null = null
  let pendingTranscript = ''

  // VAD internal state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let vad: any = null
  let vadPhase: 'passive' | 'active' = 'passive'
  let wakeCheckInFlight = false
  let minWindowElapsed = false
  let activeListeningTimer: ReturnType<typeof setTimeout> | null = null
  let minWindowTimer: ReturnType<typeof setTimeout> | null = null

  // ── WebSocket ────────────────────────────────────────────────────────────────

  function connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => { isConnected.value = true }
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
        state.value = event.state
        break
      case 'transcript':
        pendingTranscript = event.text
        currentTranscript.value = event.text
        break
      case 'response':
        if (pendingTranscript) {
          exchanges.value.push({ heard: pendingTranscript, reply: event.text })
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
    if (!audioCtx) audioCtx = new AudioContext()
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const decoded = await audioCtx.decodeAudioData(bytes.buffer)
    const source = audioCtx.createBufferSource()
    source.buffer = decoded
    source.connect(audioCtx.destination)
    source.start()
  }

  function playAckSound(): void {
    console.log('[vad] playing ack sound')
    new Audio('/ack-sound.mp3').play().catch((err) => {
      console.warn('[vad] ack sound blocked:', err)
    })
  }

  // ── Manual recording ─────────────────────────────────────────────────────────

  async function startRecording(): Promise<void> {
    if (mediaRecorder?.state === 'recording') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioChunks = []
      mediaRecorder = new MediaRecorder(stream)
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data) }
      mediaRecorder.start()
    } catch (err) {
      error.value = `Microphone access denied: ${err instanceof Error ? err.message : err}`
      setTimeout(() => { error.value = null }, 5000)
    }
  }

  function stopRecording(): void {
    if (!mediaRecorder || mediaRecorder.state === 'inactive' || !ws) return
    const currentWs = ws
    mediaRecorder.onstop = async () => {
      if (!currentWs) return
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      currentWs.send(await blob.arrayBuffer())
    }
    mediaRecorder.stop()
    mediaRecorder.stream.getTracks().forEach((t) => t.stop())
  }

  // ── Passive VAD + wake word ───────────────────────────────────────────────────

  async function handleSpeechEnd(audio: Float32Array): Promise<void> {
    console.log('[vad] onSpeechEnd fired — phase:', vadPhase, '| samples:', audio.length, '| inFlight:', wakeCheckInFlight)
    if (vadPhase === 'passive') {
      if (wakeCheckInFlight) return
      wakeCheckInFlight = true
      try {
        await checkWakeWord(audio)
      } finally {
        wakeCheckInFlight = false
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
      if (result.heard.toLowerCase().includes('home')) {
        await triggerActiveStart()
      }
    } catch (err) {
      console.warn('[vad] wakeword check failed:', err)
    }
  }

  async function triggerActiveStart(): Promise<void> {
    console.log('[vad] wake word matched — starting active listening')
    vadPhase = 'active'
    minWindowElapsed = false

    if (vad) vad.pause()
    playAckSound()
    await startRecording()

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
    if (vad) return // already running
    try {
      // Dynamic import — client-side only; never runs on server
      const { MicVAD } = await import('@ricky0123/vad-web')
      vad = await MicVAD.new({
        baseAssetPath: '/_vad/',
        onnxWASMBasePath: '/_vad/',
        model: 'v5',
        minSpeechFrames: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ortConfig: (ort: any) => { ort.env.wasm.numThreads = 1 },
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
    if (passiveEnabled.value) void startPassiveListening()
  })

  onUnmounted(() => {
    ws?.close()
    stopPassiveListening()
  })

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
    passiveEnabled,
    isPassive,
    startRecording,
    stopRecording,
    sendPing,
    clearHistory,
  }
}
