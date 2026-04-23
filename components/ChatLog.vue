<script setup lang="ts">
import type { LogItem } from '~/composables/useVoice'
import { renderInlineMarkdown, truncatePreview } from '~/shared/text'

const props = defineProps<{
  log: readonly LogItem[]
}>()

const scrollEl = ref<HTMLElement | null>(null)
/** User may have scrolled up to read history — don't yank them back to bottom on each delta. */
const autoStickBottom = ref(true)

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  autoStickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

// Appends do a smooth scroll for the reveal; mid-stream text growth uses auto to avoid jitter.
let lastSeenLength = 0
watch(
  () => [props.log.length, props.log.at(-1)?.text ?? ''],
  async () => {
    if (!autoStickBottom.value) return
    const appended = props.log.length !== lastSeenLength
    lastSeenLength = props.log.length
    await nextTick()
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: appended ? 'smooth' : 'auto' })
  },
)
</script>

<template>
  <div
    v-if="log.length > 0"
    class="fixed inset-x-0 z-30 pointer-events-none"
    :style="{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' }"
  >
    <div
      ref="scrollEl"
      class="chat-log-scroll mx-auto max-w-[1080px] px-4 pointer-events-auto max-h-[50vh] overflow-y-auto overscroll-contain"
      @scroll="onScroll"
    >
      <TransitionGroup
        tag="div"
        name="bubble"
        class="flex flex-col gap-2 py-12"
      >
        <div
          v-for="item in log"
          :key="item.id"
          :class="item.kind === 'user' ? 'flex justify-end' : 'flex justify-start'"
        >
          <div
            v-if="item.kind === 'user'"
            class="backdrop-blur-xl bg-ap-blue/15 border border-ap-blue/20 rounded-xl rounded-br-sm px-4 py-2.5 shadow-[0_4px_24px_rgba(0,0,0,0.3)] max-w-[85%]"
          >
            <p class="text-sm font-mono text-ap-blue/90 leading-relaxed">{{ item.text }}</p>
          </div>
          <div
            v-else-if="item.kind === 'message'"
            class="backdrop-blur-xl bg-black/60 border border-ap-orange/25 rounded-xl rounded-bl-sm px-4 py-2.5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] max-w-[85%]"
          >
            <p class="chat-md text-sm font-mono text-gray-100 leading-relaxed whitespace-pre-wrap">
              <span v-html="renderInlineMarkdown(item.text)" /><span
                v-if="item.streaming"
                class="inline-block w-[2px] h-[14px] bg-ap-orange/80 ml-0.5 align-middle animate-pulse"
              />
            </p>
          </div>
          <div
            v-else
            class="backdrop-blur-md bg-black/40 border border-white/5 rounded-lg px-3 py-1.5 max-w-[85%]"
          >
            <p class="text-xs font-mono text-gray-500 leading-relaxed">
              <span class="text-ap-blue/70">{{ item.kind === 'tool_call' ? '→' : '←' }}</span>
              <template v-if="item.kind === 'tool_call'">
                {{ ' ' }}{{ item.tool ?? 'tool' }}<span v-if="item.text" class="text-gray-600"> ({{ truncatePreview(item.text, 80) }})</span><span v-if="item.streaming" class="text-gray-600"> …</span>
              </template>
              <template v-else>
                {{ ' ' }}{{ truncatePreview(item.text, 140) }}
              </template>
            </p>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.chat-log-scroll {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 48px, black calc(100% - 48px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, black 48px, black calc(100% - 48px), transparent 100%);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}
.chat-log-scroll::-webkit-scrollbar {
  width: 4px;
}
.chat-log-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.chat-log-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

.chat-md :deep(strong) { color: rgb(255 255 255 / 0.95); font-weight: 600; }
.chat-md :deep(em) { font-style: italic; color: rgb(255 255 255 / 0.9); }
.chat-md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(255, 255, 255, 0.08);
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}
.chat-md :deep(a) {
  color: rgb(var(--color-ap-blue, 59 130 246) / 0.9);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.bubble-enter-active {
  transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.bubble-enter-from {
  opacity: 0;
  transform: translateY(18px);
}
.bubble-enter-to {
  opacity: 1;
  transform: translateY(0);
}
.bubble-move {
  transition: transform 0.3s ease-out;
}
</style>
