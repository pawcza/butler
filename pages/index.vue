<script setup lang="ts">
const {
  state,
  isConnected,
  exchanges,
  currentTranscript,
  error,
  startRecording,
  stopRecording,
  clearHistory,
  passiveEnabled,
  isPassive,
} = useVoice()

const isRecording = ref(false)
const transcriptEl = ref<HTMLElement | null>(null)

const canInteract = computed(() => isConnected.value && state.value === 'IDLE')

// Minimum hold time (ms) to avoid sending near-empty audio on accidental clicks
const MIN_HOLD_MS = 300
let pressStartedAt = 0

// Virtual display state — resolves local recording and passive listening into display states.
// Server LISTENING = transcribing audio (processing phase) → show as THINKING.
// Local isRecording = actively capturing mic → show as LISTENING (blue).
const activeState = computed(() => {
  if (isRecording.value && state.value === 'IDLE') return 'LISTENING'
  if (isPassive.value && state.value === 'IDLE') return 'PASSIVE'
  if (state.value === 'LISTENING') return 'THINKING'
  return state.value
})

function onPressStart(e: Event): void {
  e.preventDefault()
  if (!canInteract.value) return
  pressStartedAt = Date.now()
  isRecording.value = true
  void startRecording()
}

function onPressEnd(): void {
  if (!isRecording.value) return
  isRecording.value = false
  if (Date.now() - pressStartedAt < MIN_HOLD_MS) {
    // Too short — discard without sending
    stopRecording(true)
    return
  }
  stopRecording()
}

// Spacebar push-to-talk
function handleKeyDown(e: KeyboardEvent): void {
  if (
    e.code === 'Space' &&
    !e.repeat &&
    document.activeElement?.tagName !== 'INPUT' &&
    document.activeElement?.tagName !== 'TEXTAREA'
  ) {
    onPressStart(e)
  }
}

function handleKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') onPressEnd()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
})

// Auto-scroll transcript to bottom
watch([exchanges, currentTranscript], async () => {
  await nextTick()
  if (transcriptEl.value) transcriptEl.value.scrollTop = transcriptEl.value.scrollHeight
}, { deep: true })

const stateLabel: Record<string, string> = {
  IDLE: 'Hold to speak',
  PASSIVE: 'Awaiting wake word…',
  LISTENING: 'Listening…',
  THINKING: 'Processing…',
  EXECUTING: 'Executing…',
  SPEAKING: 'Speaking…',
}

const stateLabelClass = computed(() => {
  switch (activeState.value) {
    case 'PASSIVE': return 'text-ap-orange/60'
    case 'LISTENING': return 'text-ap-blue'
    case 'THINKING': return 'text-amber-400'
    case 'EXECUTING': return 'text-green-400'
    case 'SPEAKING': return 'text-purple-400'
    default: return 'text-ap-muted'
  }
})
</script>

<template>
  <div class="select-none">
    <!-- 3D background — full screen behind everything -->
    <GladosAvatar
      :active-state="activeState"
      @press-start="onPressStart"
      @press-end="onPressEnd"
    />

    <!-- UI overlay — fixed on top, 100dvh to respect mobile browser chrome -->
    <div class="fixed inset-0 z-10 flex flex-col h-[100dvh] pointer-events-none overflow-hidden">
      <!-- Top bar: nav + status, blurred background -->
      <div class="pointer-events-auto shrink-0 backdrop-blur-xl bg-black/50 border-b border-white/5">
        <!-- Navigation row -->
        <div class="flex items-center gap-6 px-6 pt-3 pb-1">
          <span class="text-ap-orange font-bold tracking-widest text-sm uppercase">GLaDOS</span>
        </div>

        <!-- Status row -->
        <div class="flex items-center justify-between px-6 pt-1 pb-3">
          <div class="flex items-center gap-2 text-[10px] font-mono tracking-widest uppercase text-ap-muted">
            <span
              class="w-1.5 h-1.5 rounded-full"
              :class="isConnected ? 'bg-green-500 shadow-[0_0_4px_rgba(74,222,128,0.7)]' : 'bg-ap-red'"
            />
            {{ isConnected ? 'Online' : 'Offline' }}
          </div>
          <button
            class="text-[10px] font-mono tracking-widest uppercase transition-colors duration-200"
            :class="passiveEnabled ? 'text-ap-blue' : 'text-ap-muted/40 hover:text-ap-muted'"
            @click="passiveEnabled = !passiveEnabled"
          >
            {{ passiveEnabled ? '● Passive' : '○ Passive' }}
          </button>
          <button
            class="text-[10px] font-mono tracking-widest uppercase text-ap-muted hover:text-white transition-colors duration-200"
            @click="clearHistory"
          >
            Clear
          </button>
        </div>

        <!-- Error toast -->
        <Transition
          enter-active-class="transition-all duration-300"
          leave-active-class="transition-all duration-300"
          enter-from-class="opacity-0 -translate-y-1"
          leave-to-class="opacity-0 -translate-y-1"
        >
          <div
            v-if="error"
            class="mx-6 mb-3 text-xs font-mono text-ap-red bg-ap-red/10 border border-ap-red/20 rounded px-3 py-2"
          >
            {{ error }}
          </div>
        </Transition>
      </div>

      <!-- Middle — transparent, shows 3D scene. State label floats above bottom bar. -->
      <div class="flex-1" />

      <!-- State label — floating above transcript -->
      <div class="flex justify-center pb-2">
        <span
          class="text-[9px] font-mono tracking-[0.2em] uppercase transition-colors duration-500 backdrop-blur-md bg-black/30 px-3 py-1 rounded-full"
          :class="stateLabelClass"
        >
          {{ stateLabel[activeState] ?? activeState }}
        </span>
      </div>

      <!-- Transcript — bottom, with blurred background -->
      <div class="pointer-events-auto shrink-0 select-text backdrop-blur-xl bg-black/50 border-t border-white/5">
        <div
          ref="transcriptEl"
          class="transcript-scroll max-h-[30vh] overflow-y-auto overscroll-contain touch-pan-y px-6 pt-3 pb-6 space-y-3"
        >
          <div
            v-if="exchanges.length === 0 && !currentTranscript"
            class="flex justify-center"
          >
            <p class="text-[9px] font-mono tracking-[0.2em] uppercase text-ap-muted/30">
              Aperture Science Domestic Assistance Android
            </p>
          </div>

          <div v-for="(ex, i) in exchanges" :key="i" class="space-y-1">
            <div class="flex gap-3 items-baseline">
              <span class="shrink-0 w-12 text-[9px] font-mono tracking-[0.15em] uppercase text-ap-muted">You</span>
              <span class="text-sm font-mono text-ap-blue/80">{{ ex.heard }}</span>
            </div>
            <div class="flex gap-3 items-baseline">
              <span class="shrink-0 w-12 text-[9px] font-mono tracking-[0.15em] uppercase text-ap-orange">GLaDOS</span>
              <span class="text-sm font-mono text-gray-300">{{ ex.reply }}</span>
            </div>
          </div>

          <div v-if="currentTranscript" class="flex gap-3 items-baseline opacity-40">
            <span class="shrink-0 w-12 text-[9px] font-mono tracking-[0.15em] uppercase text-ap-muted">You</span>
            <span class="text-sm font-mono text-ap-blue italic">{{ currentTranscript }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.transcript-scroll {
  mask-image: linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%);
}
</style>
