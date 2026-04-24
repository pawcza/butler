<script setup lang="ts">
const props = defineProps<{
  volume: number
}>()

const emit = defineEmits<{
  (e: 'update:volume', v: number): void
}>()

const volumeBeforeMute = ref(0.8)

function onInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).valueAsNumber
  if (Number.isFinite(raw)) emit('update:volume', raw)
}

function toggleMute(): void {
  if (props.volume > 0) {
    volumeBeforeMute.value = props.volume
    emit('update:volume', 0)
  } else {
    emit('update:volume', volumeBeforeMute.value || 0.8)
  }
}

/** Speaker glyph paths by level — mute / one wave / two waves. */
const iconPath = computed(() => {
  if (props.volume <= 0) return 'M11 5L6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6'
  if (props.volume < 0.5) return 'M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07'
  return 'M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14'
})
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-2 px-2 py-1 rounded-full bg-white/5 border border-white/10 backdrop-blur-xl">
    <button
      class="text-white/60 hover:text-white transition-colors duration-150 p-1 min-h-[28px] min-w-[28px] flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-white/30 rounded"
      :aria-label="volume === 0 ? 'Unmute' : 'Mute'"
      @click="toggleMute"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path :d="iconPath" />
      </svg>
    </button>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      :value="volume"
      aria-label="Volume"
      class="volume-slider"
      @input="onInput"
    >
  </div>
</template>

<style scoped>
.volume-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 96px;
  height: 3px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}
.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  background: rgb(255, 255, 255);
  border-radius: 50%;
  border: none;
  box-shadow: 0 0 6px rgba(255, 102, 0, 0.4);
  transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
}
.volume-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
  box-shadow: 0 0 10px rgba(255, 102, 0, 0.7);
}
.volume-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  background: rgb(255, 255, 255);
  border-radius: 50%;
  border: none;
  box-shadow: 0 0 6px rgba(255, 102, 0, 0.4);
  cursor: pointer;
}
.volume-slider::-moz-range-thumb:hover {
  box-shadow: 0 0 10px rgba(255, 102, 0, 0.7);
}
</style>
