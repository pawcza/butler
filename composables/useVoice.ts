import type { ServerEvent, SessionState } from '~/shared/types'

export interface Exchange {
  heard: string
  reply: string
}

export function useVoice() {
  const state = ref<SessionState>('IDLE')
  const isConnected = ref(false)
  const exchanges = ref<Exchange[]>([])
  const currentTranscript = ref('')
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: Blob[] = []
  let audioCtx: AudioContext | null = null
  let pendingTranscript = ''

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

  async function startRecording(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioChunks = []
    mediaRecorder = new MediaRecorder(stream)
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data) }
    mediaRecorder.start()
  }

  function stopRecording(): void {
    if (!mediaRecorder || !ws) return
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      ws!.send(await blob.arrayBuffer())
    }
    mediaRecorder.stop()
    mediaRecorder.stream.getTracks().forEach((t) => t.stop())
  }

  function sendPing(): void {
    ws?.send(JSON.stringify({ type: 'ping' }))
  }

  function clearHistory(): void {
    ws?.send(JSON.stringify({ type: 'clear_history' }))
    exchanges.value = []
    currentTranscript.value = ''
    pendingTranscript = ''
  }

  onMounted(connect)
  onUnmounted(() => ws?.close())

  return {
    state,
    isConnected,
    exchanges,
    currentTranscript,
    error,
    startRecording,
    stopRecording,
    sendPing,
    clearHistory,
  }
}
