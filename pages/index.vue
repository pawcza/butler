<script setup lang="ts">
import { loadGsap, getGsap } from '~/utils/gsap'

const {
  state,
  isConnected,
  error,
  chatLog,
  sendCommand,
  startRecording,
  stopRecording,
  isProcessingWake,
  audioEnergy,
  availableModels,
  selectedModel,
  selectedVoice,
  setVoice,
  volume,
  setVolume,
} = useVoice()

function onVoiceChange(payload: { model: string; voice: string }): void {
  setVoice(payload.model, payload.voice)
}

const isRecording = ref(false)
const isFullscreen = ref(false)

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {})
    isFullscreen.value = true
  } else {
    document.exitFullscreen().catch(() => {})
    isFullscreen.value = false
  }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', () => {
    isFullscreen.value = !!document.fullscreenElement
  })
})

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
  return state.value
})

function beginSpeaking(): void {
  if (!canInteract.value) return
  pressStartedAt = Date.now()
  isRecording.value = true
  void startRecording()
}

function onPressStart(e: Event): void {
  // Avatar + spacebar path: preventDefault so space doesn't page-scroll and touch doesn't
  // trigger native gestures on the canvas. Chat log calls beginSpeaking directly so native
  // scroll can proceed.
  e.preventDefault()
  beginSpeaking()
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

function handleKeyDown(e: KeyboardEvent): void {
  if (
    document.activeElement?.tagName === 'INPUT' ||
    document.activeElement?.tagName === 'TEXTAREA'
  ) return
  if (e.code === 'Space' && !e.repeat) onPressStart(e)
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

const stateLabel: Record<string, string> = {
  IDLE: 'Hold click or space to speak',
  LISTENING: 'Listening\u2026',
  THINKING: 'Processing\u2026',
  SPEAKING: 'Speaking\u2026',
}

const stateLabelClass = computed(() => {
  switch (activeState.value) {
    case 'LISTENING': return 'text-ap-blue'
    case 'THINKING': return 'text-amber-400'
    case 'SPEAKING': return 'text-orange-400'
    default: return 'text-ap-muted'
  }
})

// ── GSAP animations on mount ────────────────────────────────────────────────
const brandingEl = ref<HTMLElement | null>(null)
const stateLabelEl = ref<HTMLElement | null>(null)
const errorEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  const gsap = await loadGsap()

  if (brandingEl.value) {
    gsap.from(brandingEl.value, { opacity: 0, y: -10, duration: 0.6, ease: 'power2.out', delay: 0.2 })
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
      <!-- Top bar — branding (left) + audio/fullscreen controls (right) -->
      <div ref="brandingEl" class="shrink-0 flex items-center gap-3 px-4 sm:px-6 pt-5 safe-area-top">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-2xl sm:text-3xl font-black tracking-[0.25em] uppercase text-ap-orange drop-shadow-[0_0_20px_rgba(255,102,0,0.4)]">BUTLER</span>
          <span
            class="w-2 h-2 rounded-full shrink-0 transition-colors duration-500"
            :class="isConnected ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-ap-red shadow-[0_0_8px_rgba(239,68,68,0.8)]'"
            :aria-label="isConnected ? 'Connected' : 'Disconnected'"
          />
        </div>

        <div class="ml-auto flex items-center gap-2 sm:gap-3">
          <VolumeControl
            class="hidden sm:flex"
            :volume="volume"
            @update:volume="setVolume"
          />
          <VoiceSelector
            v-if="availableModels.length > 0"
            class="pointer-events-auto"
            :models="availableModels"
            :selected-model="selectedModel"
            :selected-voice="selectedVoice"
            @update:voice="onVoiceChange"
          />
          <button
            class="pointer-events-auto text-white/50 hover:text-white transition-colors duration-200 p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-white/5"
            aria-label="Toggle fullscreen"
            @click="toggleFullscreen"
          >
            <svg v-if="!isFullscreen" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
          </button>
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

    <!-- Persistent chat log — accumulates transcripts + Hermes output blocks across the session.
         ClientOnly: rehydrated from localStorage, so SSR would mismatch. -->
    <ClientOnly>
      <ChatLog
        :log="chatLog"
        :can-send="canInteract"
        @press-start="beginSpeaking"
        @press-end="onPressEnd"
        @send="sendCommand"
      />
    </ClientOnly>

  </div>
</template>

<style scoped>
/* Safe-area insets for notched devices (iPhone X+, Android with display cutouts) */
.safe-area-top {
  padding-top: max(1.5rem, env(safe-area-inset-top));
}
.safe-area-bottom {
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
}
</style>
