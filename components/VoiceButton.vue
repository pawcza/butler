<script setup lang="ts">
import type { SessionState } from '~/shared/types'

const props = defineProps<{
  state: SessionState
  disabled?: boolean
}>()

const emit = defineEmits<{
  start: []
  stop: []
}>()

const isRecording = ref(false)

const canRecord = computed(() => !props.disabled && props.state === 'IDLE')

const stateLabel: Record<SessionState, string> = {
  IDLE: 'Hold to speak',
  LISTENING: 'Listening…',
  THINKING: 'Thinking…',
  EXECUTING: 'Executing…',
  SPEAKING: 'Speaking…',
}

const ringColor: Record<SessionState, string> = {
  IDLE: 'ring-ap-muted',
  LISTENING: 'ring-ap-blue animate-pulse',
  THINKING: 'ring-ap-orange animate-pulse',
  EXECUTING: 'ring-ap-orange',
  SPEAKING: 'ring-ap-blue',
}

function onPressStart(e: Event): void {
  e.preventDefault()
  if (!canRecord.value) return
  isRecording.value = true
  emit('start')
}

function onPressEnd(): void {
  if (!isRecording.value) return
  isRecording.value = false
  emit('stop')
}
</script>

<template>
  <div class="flex flex-col items-center gap-4">
    <button
      class="w-28 h-28 rounded-full flex items-center justify-center ring-4 transition-all duration-150 select-none"
      :class="[
        ringColor[state],
        isRecording ? 'bg-ap-blue scale-110' : 'bg-ap-panel hover:bg-ap-border',
        !canRecord ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
      ]"
      @mousedown="onPressStart"
      @mouseup="onPressEnd"
      @mouseleave="onPressEnd"
      @touchstart.prevent="onPressStart"
      @touchend="onPressEnd"
    >
      <svg
        class="w-10 h-10"
        :class="isRecording ? 'text-white' : 'text-gray-400'"
        fill="currentColor"
        viewBox="0 0 24 24"
      >
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
      </svg>
    </button>
    <span class="text-xs text-gray-500 tracking-widest uppercase">{{ stateLabel[state] }}</span>
  </div>
</template>
