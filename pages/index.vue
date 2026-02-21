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
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-49px)] max-w-2xl mx-auto px-4 py-6 gap-6">
    <!-- Connection status -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 text-xs text-ap-muted">
        <span
          class="w-2 h-2 rounded-full"
          :class="isConnected ? 'bg-green-500' : 'bg-red-500'"
        />
        {{ isConnected ? 'Connected' : 'Disconnected' }}
      </div>
      <button
        class="text-xs text-ap-muted hover:text-white transition-colors"
        @click="clearHistory"
      >
        Clear history
      </button>
    </div>

    <!-- Error toast -->
    <Transition enter-active-class="transition-opacity duration-200" leave-active-class="transition-opacity duration-200" enter-from-class="opacity-0" leave-to-class="opacity-0">
      <div v-if="error" class="text-xs text-ap-red bg-ap-panel border border-ap-red/30 rounded px-3 py-2">
        {{ error }}
      </div>
    </Transition>

    <!-- Transcript log -->
    <TranscriptLog :exchanges="exchanges" :current-transcript="currentTranscript" />

    <!-- Voice button -->
    <div class="flex justify-center pb-4">
      <VoiceButton
        :state="state"
        :disabled="!isConnected"
        @start="startRecording"
        @stop="stopRecording"
      />
    </div>
  </div>
</template>
