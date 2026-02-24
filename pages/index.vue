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
  isHearing,
  isProcessingWake,
  audioEnergy,
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
  if (isProcessingWake.value) return 'THINKING'
  if (isHearing.value && isPassive.value && state.value === 'IDLE') return 'HEARING'
  if (isRecording.value && state.value === 'IDLE') return 'LISTENING'
  if (isPassive.value && state.value === 'IDLE') return 'PASSIVE'
  if (state.value === 'LISTENING') return 'THINKING'
  return state.value
})

function onPressStart(e: Event): void {
  e.preventDefault()
  if (!canInteract.value) return
  isHearing.value = false
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

// ── Chat panel state ──────────────────────────────────────────────────────────
const panelOpen = ref(false)
const hasUnread = ref(false)

// Auto-scroll transcript to bottom
watch([exchanges, currentTranscript], async () => {
  await nextTick()
  if (transcriptEl.value) transcriptEl.value.scrollTop = transcriptEl.value.scrollHeight
}, { deep: true })

// Notification dot when new messages arrive while panel is closed
watch(() => exchanges.value.length, () => {
  if (!panelOpen.value) hasUnread.value = true
})

// Clear unread when panel opens
watch(panelOpen, (open) => {
  if (open) hasUnread.value = false
})

// Close panel on click outside (mobile backdrop)
function onBackdropClick(): void {
  panelOpen.value = false
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

const stateLabel: Record<string, string> = {
  IDLE: 'Hold to speak',
  PASSIVE: 'Awaiting wake word\u2026',
  HEARING: 'Hearing\u2026',
  LISTENING: 'Listening\u2026',
  THINKING: 'Processing\u2026',
  EXECUTING: 'Executing\u2026',
  SPEAKING: 'Speaking\u2026',
}

const stateLabelClass = computed(() => {
  switch (activeState.value) {
    case 'PASSIVE': return 'text-ap-orange/60'
    case 'HEARING': return 'text-yellow-300'
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
      :audio-energy="audioEnergy"
      @press-start="onPressStart"
      @press-end="onPressEnd"
    />

    <!-- UI overlay — fixed on top, 100dvh to respect mobile browser chrome -->
    <div class="fixed inset-0 z-10 flex flex-col h-[100dvh] pointer-events-none overflow-hidden">
      <!-- Top bar: nav + status, blurred background -->
      <div class="pointer-events-auto shrink-0 backdrop-blur-xl bg-black/50 border-b border-white/5">
        <!-- Orange accent line -->
        <div class="h-[2px] bg-ap-orange/80" />

        <!-- Navigation row -->
        <div class="flex items-center gap-3 px-6 pt-3 pb-1">
          <span class="text-ap-orange font-bold tracking-widest text-xl uppercase">GLaDOS</span>
          <span class="text-[10px] font-mono tracking-wider text-ap-muted/60 uppercase">v2.0</span>
        </div>

        <!-- Status row -->
        <div class="flex items-center gap-3 px-6 pt-1 pb-3">
          <div class="flex items-center gap-2 text-xs font-mono tracking-widest uppercase text-gray-400">
            <span
              class="w-2 h-2 rounded-full"
              :class="isConnected ? 'bg-green-500 shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-ap-red'"
            />
            {{ isConnected ? 'Online' : 'Offline' }}
          </div>
          <div class="flex-1" />
          <button
            class="min-h-[36px] px-3 text-xs font-mono tracking-widest uppercase transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-ap-blue/50 active:scale-95 rounded-full border"
            :class="passiveEnabled ? 'text-ap-blue bg-ap-blue/20 border-ap-blue/30' : 'text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-500'"
            aria-label="Toggle passive listening mode"
            @click="passiveEnabled = !passiveEnabled"
          >
            {{ passiveEnabled ? '● Passive' : '○ Passive' }}
          </button>
          <button
            class="min-h-[36px] px-3 text-xs font-mono tracking-widest uppercase text-gray-400 hover:text-white hover:bg-white/10 border border-gray-700 hover:border-gray-500 transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-ap-blue/50 active:scale-95 rounded-full"
            aria-label="Clear conversation history"
            @click="clearHistory"
          >
            &times; Clear
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
            role="alert"
            class="mx-6 mb-3 text-xs font-mono text-ap-red bg-ap-red/10 border border-ap-red/20 rounded px-3 py-2"
          >
            {{ error }}
          </div>
        </Transition>
      </div>

      <!-- Middle — transparent, shows 3D scene. State label centered. -->
      <div class="flex-1 flex items-end justify-center pb-4">
        <span
          class="text-[9px] font-mono tracking-[0.2em] uppercase transition-colors duration-500 backdrop-blur-md bg-black/30 px-3 py-1 rounded-full flex items-center gap-1.5"
          :class="stateLabelClass"
        >
          {{ stateLabel[activeState] ?? activeState }}
          <span
            v-if="activeState === 'THINKING' || activeState === 'EXECUTING'"
            class="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
            :class="activeState === 'THINKING' ? 'bg-amber-400' : 'bg-green-400'"
          />
        </span>
      </div>
    </div>

    <!-- Chat panel toggle button — always visible on the left -->
    <button
      class="fixed top-1/2 -translate-y-1/2 z-30 pointer-events-auto flex items-center justify-center w-6 h-14 rounded-r-md backdrop-blur-md bg-black/50 border border-l-0 border-white/10 text-ap-muted hover:text-white hover:bg-black/70 transition-all duration-300 ease-out focus:outline-none"
      :class="panelOpen ? 'max-sm:hidden left-[380px]' : 'left-0'"
      aria-label="Toggle conversation panel"
      @click="panelOpen = !panelOpen"
    >
      <span class="text-sm font-mono leading-none">{{ panelOpen ? '\u2039' : '\u203A' }}</span>
      <span
        v-if="hasUnread && !panelOpen"
        class="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-ap-orange shadow-[0_0_6px_rgba(255,102,0,0.7)]"
      />
    </button>

    <!-- Mobile backdrop overlay -->
    <Transition
      enter-active-class="transition-opacity duration-300"
      leave-active-class="transition-opacity duration-300"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="panelOpen"
        class="fixed inset-0 z-20 bg-black/40 sm:hidden pointer-events-auto"
        @click="onBackdropClick"
      />
    </Transition>

    <!-- Slide-in chat panel -->
    <div
      class="fixed top-0 left-0 z-20 h-[100dvh] w-full sm:w-[380px] pointer-events-auto flex flex-col backdrop-blur-xl bg-black/60 border-r border-white/10 transition-transform duration-300 ease-out select-text"
      :class="panelOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <!-- Panel header -->
      <div class="shrink-0 flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/5">
        <span class="text-xs font-mono tracking-[0.2em] uppercase text-gray-400">Conversation</span>
        <div class="flex items-center gap-2">
          <button
            class="text-[10px] font-mono tracking-widest uppercase text-ap-muted hover:text-white transition-colors duration-200 focus:outline-none px-2 py-1 rounded"
            aria-label="Clear conversation history"
            @click="clearHistory"
          >
            Clear
          </button>
          <button
            class="text-lg text-ap-muted hover:text-white transition-colors duration-200 focus:outline-none px-1"
            aria-label="Close conversation panel"
            @click="panelOpen = false"
          >
            &times;
          </button>
        </div>
      </div>

      <!-- Messages area -->
      <div
        ref="transcriptEl"
        class="transcript-scroll flex-1 overflow-y-auto overscroll-contain touch-pan-y px-5 pt-4 pb-6 space-y-4"
      >
        <!-- Empty state -->
        <div
          v-if="exchanges.length === 0 && !currentTranscript"
          class="flex items-center justify-center h-full"
        >
          <div class="flex flex-col items-center gap-2">
            <span class="text-sm font-mono tracking-[0.2em] uppercase text-ap-orange/60">Aperture Science</span>
            <span class="text-[10px] font-mono tracking-[0.15em] uppercase text-ap-muted/40">No conversation yet</span>
          </div>
        </div>

        <!-- Exchanges -->
        <template v-for="(ex, i) in exchanges" :key="i">
          <div class="space-y-2">
            <!-- User message -->
            <div class="flex justify-end">
              <span class="text-sm font-mono text-ap-blue/80 bg-ap-blue/15 rounded-lg rounded-br-sm px-3 py-1.5 max-w-[85%]">{{ ex.heard }}</span>
            </div>
            <!-- GLaDOS reply -->
            <div class="flex justify-start">
              <span class="text-sm font-mono text-gray-300 bg-white/5 rounded-lg rounded-bl-sm px-3 py-1.5 max-w-[85%]">{{ ex.reply }}</span>
            </div>
            <!-- Timestamp -->
            <div class="flex justify-center">
              <span class="text-[9px] font-mono text-ap-muted/40">{{ formatTime(ex.timestamp) }}</span>
            </div>
          </div>
        </template>

        <!-- Live transcript -->
        <div v-if="currentTranscript" class="flex justify-end opacity-70">
          <span class="text-sm font-mono text-ap-blue/60 italic bg-ap-blue/5 rounded-lg rounded-br-sm px-3 py-1.5 max-w-[85%]">{{ currentTranscript }}</span>
        </div>
      </div>

      <!-- Panel footer — state label -->
      <div class="shrink-0 flex justify-center py-3 border-t border-white/5">
        <span
          class="text-[9px] font-mono tracking-[0.2em] uppercase flex items-center gap-1.5"
          :class="stateLabelClass"
        >
          {{ stateLabel[activeState] ?? activeState }}
          <span
            v-if="activeState === 'THINKING' || activeState === 'EXECUTING'"
            class="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
            :class="activeState === 'THINKING' ? 'bg-amber-400' : 'bg-green-400'"
          />
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.transcript-scroll {
  mask-image: linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%);
}
</style>
