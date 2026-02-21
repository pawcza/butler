<script setup lang="ts">
import type { Exchange } from '~/composables/useVoice'

const props = defineProps<{
  exchanges: Exchange[]
  currentTranscript: string
}>()

const logEl = ref<HTMLElement | null>(null)

watch(
  () => [props.exchanges, props.currentTranscript],
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
  { deep: true },
)
</script>

<template>
  <div
    ref="logEl"
    class="flex-1 overflow-y-auto space-y-4 px-2 py-4 min-h-0"
  >
    <div
      v-for="(ex, i) in exchanges"
      :key="i"
      class="space-y-1"
    >
      <div class="text-ap-blue text-sm">
        <span class="text-ap-muted text-xs uppercase tracking-wider mr-2">You</span>
        {{ ex.heard }}
      </div>
      <div class="text-gray-300 text-sm pl-4 border-l border-ap-border">
        <span class="text-ap-orange text-xs uppercase tracking-wider mr-2">GLaDOS</span>
        {{ ex.reply }}
      </div>
    </div>

    <div v-if="currentTranscript" class="text-ap-blue text-sm opacity-60 italic">
      {{ currentTranscript }}
    </div>

    <div v-if="exchanges.length === 0 && !currentTranscript" class="text-ap-muted text-sm text-center pt-8">
      No exchanges yet. Hold the button and speak.
    </div>
  </div>
</template>
