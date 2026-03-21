<script setup lang="ts">
import { loadGsap, getGsap } from '~/utils/gsap'
import { PERSONALITIES } from '~/composables/useVoice'

const {
  state,
  isConnected,
  exchanges,
  currentTranscript,
  error,
  streamingText,
  isStreaming,
  bubbleVisible,
  bubbleUserText,
  startRecording,
  stopRecording,
  clearHistory,
  passiveEnabled,
  isPassive,
  isProcessingWake,
  audioEnergy,
  isInGracePeriod,
  availableModels,
  selectedModel,
  selectedVoice,
  setVoice,
  selectedPersonality,
  setPersonality,
} = useVoice()

function onVoiceChange(payload: { model: string; voice: string }): void {
  setVoice(payload.model, payload.voice)
}

function onPersonalityChange(id: string): void {
  setPersonality(id as import('~/shared/types').Personality)
}

const isRecording = ref(false)
const transcriptEl = ref<HTMLElement | null>(null)

const canInteract = computed(() => isConnected.value && state.value === 'IDLE')

// Minimum hold time (ms) to avoid sending near-empty audio on accidental clicks
const MIN_HOLD_MS = 300
let pressStartedAt = 0

// Virtual display state — resolves local recording into display states.
// Server LISTENING = transcribing audio (processing phase) → show as THINKING.
// Local isRecording = actively capturing mic via button → show as LISTENING.
const activeState = computed(() => {
  if (isProcessingWake.value) return 'THINKING'
  if (isRecording.value && state.value === 'IDLE') return 'LISTENING'
  if (state.value === 'LISTENING') return 'THINKING'
  if (state.value === 'EXECUTING') return 'THINKING'
  if (isInGracePeriod.value && state.value === 'IDLE') return 'GRACE'
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

// Spacebar push-to-talk + arrow keys for chat panel + Escape to close
function handleKeyDown(e: KeyboardEvent): void {
  if (
    document.activeElement?.tagName === 'INPUT' ||
    document.activeElement?.tagName === 'TEXTAREA'
  ) return

  if (e.code === 'Space' && !e.repeat) {
    onPressStart(e)
  } else if (e.code === 'ArrowRight' && !panelOpen.value) {
    panelOpen.value = true
  } else if (e.code === 'ArrowLeft' && panelOpen.value) {
    panelOpen.value = false
  } else if (e.code === 'Escape' && panelOpen.value) {
    panelOpen.value = false
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
const panelEl = ref<HTMLElement | null>(null)
const toggleBtnEl = ref<HTMLElement | null>(null)

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

// GSAP panel slide-in/out
watch(panelOpen, (open) => {
  const gsap = getGsap()
  if (!gsap || !panelEl.value) return
  gsap.to(panelEl.value, {
    x: open ? 0 : '-100%',
    duration: 0.35,
    ease: open ? 'power3.out' : 'power3.in',
  })
})

// Close panel on click outside (mobile backdrop)
function onBackdropClick(): void {
  panelOpen.value = false
}

// Toggle with elastic press animation
function onTogglePress(): void {
  const gsap = getGsap()
  if (gsap && toggleBtnEl.value) {
    gsap.fromTo(toggleBtnEl.value,
      { scale: 0.85 },
      { scale: 1, duration: 0.4, ease: 'elastic.out(1, 0.4)' },
    )
  }
  panelOpen.value = !panelOpen.value
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

const stateLabel: Record<string, string> = {
  IDLE: 'Hold to speak',
  LISTENING: 'Listening\u2026',
  THINKING: 'Processing\u2026',
  SPEAKING: 'Speaking\u2026',
  GRACE: 'Listening\u2026',
}

const stateLabelClass = computed(() => {
  switch (activeState.value) {
    case 'LISTENING': return 'text-ap-blue'
    case 'THINKING': return 'text-amber-400'
    case 'SPEAKING': return 'text-orange-400'
    case 'GRACE': return 'text-orange-400'
    default: return 'text-ap-muted'
  }
})

// ── GSAP animations on mount ────────────────────────────────────────────────
const brandingEl = ref<HTMLElement | null>(null)
const stateLabelEl = ref<HTMLElement | null>(null)
const errorEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  const gsap = await loadGsap()

  // Branding entrance
  if (brandingEl.value) {
    gsap.from(brandingEl.value, { opacity: 0, y: -10, duration: 0.6, ease: 'power2.out', delay: 0.2 })
  }

  // Initialize panel off-screen (GSAP controls position, not CSS)
  if (panelEl.value) {
    gsap.set(panelEl.value, { x: '-100%' })
  }
})

// Error toast entrance
watch(error, async (val) => {
  const gsap = getGsap()
  if (!gsap) return
  await nextTick()
  if (val && errorEl.value) {
    gsap.fromTo(errorEl.value,
      { opacity: 0, y: -8 },
      { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' },
    )
  }
})

// State label crossfade
watch(activeState, async () => {
  const gsap = getGsap()
  if (!gsap || !stateLabelEl.value) return
  gsap.fromTo(stateLabelEl.value,
    { opacity: 0, y: 4 },
    { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' },
  )
})
</script>

<template>
  <div class="select-none">
    <!-- 3D background — full screen behind everything -->
    <ButlerAvatar
      :active-state="activeState"
      :audio-energy="audioEnergy"
      @press-start="onPressStart"
      @press-end="onPressEnd"
    />

    <!-- UI overlay — fixed on top, 100dvh to respect mobile browser chrome -->
    <div class="fixed inset-0 z-10 flex flex-col h-[100dvh] pointer-events-none overflow-hidden">
      <!-- Floating branding + voice selector -->
      <div ref="brandingEl" class="shrink-0 flex items-center gap-3 px-8 pt-6 safe-area-top">
        <span class="text-3xl font-black tracking-[0.25em] uppercase text-ap-orange drop-shadow-[0_0_20px_rgba(255,102,0,0.4)]">BUTLER</span>
        <span
          class="w-2.5 h-2.5 rounded-full shrink-0 transition-colors duration-500"
          :class="isConnected ? 'bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.8)]' : 'bg-ap-red shadow-[0_0_10px_rgba(239,68,68,0.8)]'"
        />
        <!-- Voice selector dropdown -->
        <div v-if="availableModels.length > 0" class="ml-auto pointer-events-auto">
          <VoiceSelector
            :models="availableModels"
            :selected-model="selectedModel"
            :selected-voice="selectedVoice"
            :personalities="PERSONALITIES"
            :selected-personality="selectedPersonality"
            @update:voice="onVoiceChange"
            @update:personality="onPersonalityChange"
          />
        </div>
      </div>

      <!-- Error toast — floating below branding -->
      <div
        v-if="error"
        ref="errorEl"
        role="alert"
        class="mx-8 mt-3 text-xs font-mono text-ap-red bg-ap-red/10 border border-ap-red/20 rounded px-3 py-2 pointer-events-auto"
      >
        {{ error }}
      </div>

      <!-- Middle — transparent, shows 3D scene. State label centered. -->
      <div class="flex-1 flex items-end justify-center pb-4 safe-area-bottom">
        <span
          ref="stateLabelEl"
          class="text-[11px] sm:text-[9px] font-mono tracking-[0.2em] uppercase backdrop-blur-md bg-black/30 px-4 py-1.5 sm:px-3 sm:py-1 rounded-full flex items-center gap-1.5"
          :class="stateLabelClass"
        >
          {{ stateLabel[activeState] ?? activeState }}
          <span
            v-if="activeState === 'THINKING'"
            class="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
            :class="activeState === 'THINKING' ? 'bg-amber-400' : 'bg-green-400'"
          />
        </span>
      </div>
    </div>

    <!-- Chat bubbles — user transcript + streaming LLM response -->
    <StreamingBubble
      :user-text="bubbleUserText"
      :assistant-text="streamingText"
      :visible="bubbleVisible"
      :streaming="isStreaming"
    />

    <!-- Backdrop overlay when panel is open -->
    <Transition
      enter-active-class="transition-opacity duration-300"
      leave-active-class="transition-opacity duration-300"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="panelOpen"
        class="fixed inset-0 z-20 bg-black/30 pointer-events-auto"
        @click="onBackdropClick"
      />
    </Transition>

    <!-- Slide-in chat panel + toggle button — GSAP transforms the whole container -->
    <div
      ref="panelEl"
      class="fixed top-0 left-0 z-20 h-[100dvh] w-full sm:w-[380px] -translate-x-full"
    >
      <!-- Toggle button — sits at panel's right edge, always clickable -->
      <button
        ref="toggleBtnEl"
        class="absolute top-1/2 left-full -translate-y-1/2 z-30 pointer-events-auto flex items-center justify-center w-8 sm:w-6 h-16 sm:h-14 rounded-r-lg sm:rounded-r-md backdrop-blur-2xl bg-white/15 border border-l-0 border-white/25 text-white hover:bg-white/25 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ap-blue/40 focus:ring-offset-0"
        :class="panelOpen ? 'max-sm:hidden' : ''"
        aria-label="Toggle conversation panel"
        @click="onTogglePress"
      >
        <span class="text-base sm:text-sm font-mono leading-none">{{ panelOpen ? '\u2039' : '\u203A' }}</span>
        <span
          v-if="hasUnread && !panelOpen"
          class="absolute -top-1 -right-1 w-3 h-3 sm:w-2.5 sm:h-2.5 rounded-full bg-ap-orange shadow-[0_0_6px_rgba(255,102,0,0.7)]"
        />
      </button>

      <!-- Panel body -->
      <div class="h-full flex flex-col backdrop-blur-2xl bg-white/10 border-r border-white/20 select-text safe-area-left"
        :class="panelOpen ? 'pointer-events-auto' : 'pointer-events-none'"
      >
        <!-- Panel header -->
        <div class="shrink-0 flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/10">
          <span class="text-xs font-mono tracking-[0.2em] uppercase text-gray-400">Conversation</span>
          <div class="flex items-center gap-2">
            <button
              class="text-[10px] font-mono tracking-widest uppercase text-white/70 hover:text-white transition-colors duration-200 focus:outline-none focus:ring-1 focus:ring-ap-blue/40 px-3 py-2 min-h-[44px] min-w-[44px] rounded flex items-center justify-center"
              aria-label="Clear conversation history"
              @click="clearHistory"
            >
              Clear
            </button>
            <button
              class="text-lg text-white/70 hover:text-white transition-colors duration-200 focus:outline-none focus:ring-1 focus:ring-ap-blue/40 px-2 py-2 min-h-[44px] min-w-[44px] rounded flex items-center justify-center"
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
              <span class="text-sm font-mono tracking-[0.2em] uppercase text-ap-orange/60">Butler</span>
              <span class="text-[10px] font-mono tracking-[0.15em] uppercase text-ap-muted/50">No conversation yet</span>
            </div>
          </div>

          <!-- Exchanges -->
          <template v-for="(ex, i) in exchanges" :key="i">
            <div class="space-y-2">
              <!-- User message -->
              <div class="flex justify-end">
                <span class="text-sm font-mono text-ap-blue/80 bg-ap-blue/15 rounded-lg rounded-br-sm px-3 py-1.5 max-w-[85%]">{{ ex.heard }}</span>
              </div>
              <!-- Butler reply -->
              <div class="flex justify-start">
                <span class="text-sm font-mono text-gray-300 bg-white/5 rounded-lg rounded-bl-sm px-3 py-1.5 max-w-[85%]">{{ ex.reply }}</span>
              </div>
              <!-- Timestamp -->
              <div class="flex justify-center">
                <span class="text-[10px] font-mono text-ap-muted/50">{{ formatTime(ex.timestamp) }}</span>
              </div>
            </div>
          </template>

          <!-- Live transcript -->
          <div v-if="currentTranscript" class="flex justify-end opacity-70">
            <span class="text-sm font-mono text-ap-blue/60 italic bg-ap-blue/5 rounded-lg rounded-br-sm px-3 py-1.5 max-w-[85%]">{{ currentTranscript }}</span>
          </div>
        </div>

        <!-- Panel footer — state label -->
        <div class="shrink-0 flex justify-center py-3 border-t border-white/10 safe-area-bottom">
          <span
            class="text-[10px] font-mono tracking-[0.2em] uppercase flex items-center gap-1.5"
            :class="stateLabelClass"
          >
            {{ stateLabel[activeState] ?? activeState }}
            <span
              v-if="activeState === 'THINKING'"
              class="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
              :class="activeState === 'THINKING' ? 'bg-amber-400' : 'bg-green-400'"
            />
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.transcript-scroll {
  mask-image: linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%);
}

/* Safe-area insets for notched devices (iPhone X+, Android with display cutouts) */
.safe-area-top {
  padding-top: max(1.5rem, env(safe-area-inset-top));
}
.safe-area-bottom {
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
}
.safe-area-left {
  padding-left: env(safe-area-inset-left);
}
</style>
