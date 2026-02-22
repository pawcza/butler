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
} = useVoice()

const isRecording = ref(false)
const transcriptEl = ref<HTMLElement | null>(null)

const canInteract = computed(() => isConnected.value && state.value === 'IDLE')

// Only override state display during the micro-moment before WS responds
const activeState = computed(() =>
  isRecording.value && state.value === 'IDLE' ? 'LISTENING' : state.value,
)

function onPressStart(e: Event): void {
  e.preventDefault()
  if (!canInteract.value) return
  isRecording.value = true
  void startRecording()
}

function onPressEnd(): void {
  if (!isRecording.value) return
  isRecording.value = false
  stopRecording()
}

// Auto-scroll transcript to bottom
watch([exchanges, currentTranscript], async () => {
  await nextTick()
  if (transcriptEl.value) transcriptEl.value.scrollTop = transcriptEl.value.scrollHeight
}, { deep: true })

// Local isRecording (before server responds) maps to 'LISTENING'.
// Server LISTENING means STT is running — labelled separately to avoid confusion.
const stateLabel: Record<string, string> = {
  IDLE: 'Hold to speak',
  LISTENING: 'Transcribing…',
  THINKING: 'Processing…',
  EXECUTING: 'Executing…',
  SPEAKING: 'Speaking…',
}

const recordingLabel = 'Listening…'

const stateLabelClass = computed(() => {
  switch (activeState.value) {
    case 'LISTENING': return 'text-ap-blue'
    case 'THINKING':
    case 'EXECUTING': return 'text-ap-orange'
    case 'SPEAKING': return 'text-ap-blue'
    default: return 'text-ap-muted'
  }
})

// Tick positions: 8 evenly spaced radial markers
function tickStyle(i: number): Record<string, string> {
  const angle = ((i - 1) * Math.PI * 2) / 8
  const r = 93
  const x = Math.sin(angle) * r
  const y = -Math.cos(angle) * r
  return {
    top: `calc(50% + ${y}px - 5px)`,
    left: `calc(50% + ${x}px - 1px)`,
    transform: `rotate(${(i - 1) * 45}deg)`,
  }
}
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-49px)] select-none overflow-hidden">
    <!-- Status bar -->
    <div class="flex items-center justify-between px-6 pt-4 pb-2 shrink-0">
      <div class="flex items-center gap-2 text-[10px] font-mono tracking-widest uppercase text-ap-muted">
        <span
          class="w-1.5 h-1.5 rounded-full"
          :class="isConnected ? 'bg-green-500 shadow-[0_0_4px_rgba(74,222,128,0.7)]' : 'bg-ap-red'"
        />
        {{ isConnected ? 'Online' : 'Offline' }}
      </div>
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
        class="mx-6 mb-1 shrink-0 text-xs font-mono text-ap-red bg-ap-panel border border-ap-red/20 rounded px-3 py-2"
      >
        {{ error }}
      </div>
    </Transition>

    <!-- GLaDOS Entity — centered in remaining space -->
    <div class="flex-1 flex flex-col items-center justify-center gap-3">
      <button
        class="glados-entity"
        :class="`state-${activeState.toLowerCase()}`"
        @mousedown="onPressStart"
        @mouseup="onPressEnd"
        @mouseleave="onPressEnd"
        @touchstart.prevent="onPressStart"
        @touchend="onPressEnd"
      >
        <!-- Outer segmented ring -->
        <div class="ring ring-outer" />

        <!-- 8 radial tick marks -->
        <div
          v-for="i in 8"
          :key="i"
          class="tick"
          :style="tickStyle(i)"
        />

        <!-- Mid ring -->
        <div class="ring ring-mid" />

        <!-- Rectangular panel — spins on Y axis when thinking -->
        <div class="rect-panel">
          <div class="rect-face rect-front" />
          <div class="rect-face rect-back" />
        </div>

        <!-- Central eye -->
        <div class="eye">
          <div class="iris" />
          <div class="iris-glow" />
          <div class="pupil" />
          <div class="eye-shine" />
        </div>
      </button>

      <!-- State label -->
      <span
        class="text-[9px] font-mono tracking-[0.2em] uppercase transition-colors duration-500"
        :class="stateLabelClass"
      >
        {{ isRecording ? recordingLabel : (stateLabel[activeState] ?? activeState) }}
      </span>
    </div>

    <!-- Transcript — bottom, scrollable, capped height -->
    <div
      ref="transcriptEl"
      class="shrink-0 max-h-[28vh] overflow-y-auto px-6 py-3 space-y-3 border-t border-ap-border/40"
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
</template>

<style scoped>
/* ─── Color variables per state ────────────────────────── */
.glados-entity {
  --c-orange: #ff6600;
  --c-blue: #33aaff;
  --c-bg: #0a0a0a;

  --ring: var(--c-orange);
  --glow: rgba(255, 102, 0, 0.2);
  --glow-hi: rgba(255, 102, 0, 0.5);
}

.state-listening {
  --ring: var(--c-blue);
  --glow: rgba(51, 170, 255, 0.2);
  --glow-hi: rgba(51, 170, 255, 0.6);
}

.state-thinking,
.state-executing {
  --ring: var(--c-orange);
  --glow: rgba(255, 102, 0, 0.3);
  --glow-hi: rgba(255, 102, 0, 0.7);
}

.state-speaking {
  --ring: var(--c-blue);
  --glow: rgba(51, 170, 255, 0.2);
  --glow-hi: rgba(51, 170, 255, 0.5);
}

/* ─── Container ─────────────────────────────────────────── */
.glados-entity {
  position: relative;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  perspective: 600px;
  flex-shrink: 0;
}

/* ─── Rings ─────────────────────────────────────────────── */
.ring {
  position: absolute;
  border-radius: 50%;
  border: 1.5px solid transparent;
}

/* Outer ring: 4 arcs with 10° gaps, always rotating */
.ring-outer {
  inset: 0;
  background:
    linear-gradient(var(--c-bg), var(--c-bg)) padding-box,
    conic-gradient(
      from 0deg,
      var(--ring) 0deg,   var(--ring) 80deg,
      transparent 80deg,  transparent 90deg,
      var(--ring) 90deg,  var(--ring) 170deg,
      transparent 170deg, transparent 180deg,
      var(--ring) 180deg, var(--ring) 260deg,
      transparent 260deg, transparent 270deg,
      var(--ring) 270deg, var(--ring) 350deg,
      transparent 350deg, transparent 360deg
    ) border-box;
  box-shadow: 0 0 14px var(--glow);
  animation: spin 28s linear infinite;
}

.state-thinking .ring-outer,
.state-executing .ring-outer {
  animation: spin 2.5s linear infinite;
  box-shadow: 0 0 28px var(--glow-hi), 0 0 56px var(--glow);
}

.state-listening .ring-outer {
  animation: spin 9s linear infinite;
  box-shadow: 0 0 20px var(--glow);
}

.state-speaking .ring-outer {
  animation: spin 14s linear infinite;
}

/* Inner ring: counter-rotates */
.ring-mid {
  width: 152px;
  height: 152px;
  top: calc(50% - 76px);
  left: calc(50% - 76px);
  border-color: var(--ring);
  opacity: 0.22;
  animation: spin-rev 20s linear infinite;
}

.state-thinking .ring-mid,
.state-executing .ring-mid {
  animation: spin-rev 2s linear infinite;
  opacity: 0.5;
}

/* ─── Keyframes ─────────────────────────────────────────── */
@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes spin-rev {
  to { transform: rotate(-360deg); }
}

@keyframes rect-flip {
  to { transform: rotateY(360deg); }
}

@keyframes iris-pulse {
  0%, 100% { transform: scale(1);    opacity: 1; }
  50%       { transform: scale(1.12); opacity: 0.75; }
}

@keyframes iris-think {
  0%, 100% { transform: scale(1); }
  50%       { transform: scale(0.82); }
}

@keyframes iris-speak {
  0%, 100% { transform: scale(1) scaleY(1); }
  30%       { transform: scale(1.06) scaleY(0.94); }
  60%       { transform: scale(0.96) scaleY(1.06); }
}

@keyframes pupil-scan {
  0%   { transform: translate(0,   0); }
  20%  { transform: translate(4px, -3px); }
  45%  { transform: translate(-3px, 4px); }
  70%  { transform: translate(3px,  3px); }
  90%  { transform: translate(-2px, -1px); }
  100% { transform: translate(0,   0); }
}

/* ─── Tick marks ────────────────────────────────────────── */
.tick {
  position: absolute;
  width: 2px;
  height: 10px;
  background: var(--ring);
  opacity: 0.45;
  border-radius: 1px;
}

/* ─── Rectangular panel (GLaDOS core element) ───────────── */
.rect-panel {
  position: absolute;
  width: 70px;
  height: 98px;
  top: calc(50% - 49px);
  left: calc(50% - 35px);
  transform-style: preserve-3d;
}

.rect-face {
  position: absolute;
  inset: 0;
  border: 1px solid var(--ring);
  opacity: 0.3;
  backface-visibility: hidden;
}

.rect-back {
  transform: rotateY(180deg);
  border-color: var(--c-blue);
}

.state-thinking .rect-panel,
.state-executing .rect-panel {
  animation: rect-flip 2s linear infinite;
}

/* ─── Eye ───────────────────────────────────────────────── */
.eye {
  position: absolute;
  width: 106px;
  height: 106px;
  top: calc(50% - 53px);
  left: calc(50% - 53px);
  border-radius: 50%;
  background: radial-gradient(circle at 38% 33%, #1c1c1c 0%, #0d0d0d 45%, #000 100%);
  box-shadow: inset 0 0 28px rgba(0, 0, 0, 0.95), inset 0 0 10px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.iris {
  position: absolute;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 2px solid var(--ring);
  box-shadow: 0 0 10px var(--glow-hi), inset 0 0 10px var(--glow);
}

.iris-glow {
  position: absolute;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--ring) 0%, transparent 70%);
  opacity: 0.12;
}

.pupil {
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #000;
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.9);
}

.eye-shine {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  top: 27%;
  left: 33%;
}

/* ─── State-driven eye animations ───────────────────────── */
.state-listening .iris {
  animation: iris-pulse 0.9s ease-in-out infinite;
}

.state-thinking .iris {
  animation: iris-think 0.55s ease-in-out infinite;
}

.state-thinking .pupil {
  animation: pupil-scan 3.5s ease-in-out infinite;
}

.state-executing .iris {
  animation: iris-think 0.3s ease-in-out infinite;
}

.state-speaking .iris {
  animation: iris-speak 1.1s ease-in-out infinite;
}
</style>
