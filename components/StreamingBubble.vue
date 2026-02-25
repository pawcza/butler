<script setup lang="ts">
import { getGsap } from '~/utils/gsap'

const props = defineProps<{
  userText: string
  assistantText: string
  visible: boolean
  streaming: boolean
}>()

const containerEl = ref<HTMLElement | null>(null)
const shown = ref(false)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeTween: any = null

watch(() => props.visible, async (vis) => {
  if (vis) {
    // Show / re-show — kill any running fade-out
    if (activeTween) { activeTween.kill(); activeTween = null }
    if (!shown.value) {
      shown.value = true
      await nextTick()
    }
    const gsap = getGsap()
    if (gsap && containerEl.value) {
      activeTween = gsap.fromTo(containerEl.value,
        { opacity: 0, y: 12, scale: 0.95 },
        { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out',
          onComplete: () => { activeTween = null } },
      )
    }
  } else if (shown.value) {
    // Fade out — texts stay visible during animation (no flicker)
    if (activeTween) { activeTween.kill(); activeTween = null }
    const gsap = getGsap()
    if (gsap && containerEl.value) {
      activeTween = gsap.to(containerEl.value, {
        opacity: 0,
        y: 8,
        duration: 0.25,
        ease: 'power2.in',
        onComplete: () => { shown.value = false; activeTween = null },
      })
    } else {
      shown.value = false
    }
  }
})
</script>

<template>
  <div
    v-if="shown"
    ref="containerEl"
    class="fixed left-1/2 -translate-x-1/2 z-30 w-[90vw] sm:w-[400px] pointer-events-none space-y-2"
    style="bottom: max(2rem, env(safe-area-inset-bottom, 0px))"
  >
    <!-- User bubble (right-aligned) -->
    <div v-if="userText" class="flex justify-end">
      <div class="backdrop-blur-xl bg-ap-blue/15 border border-ap-blue/20 rounded-xl rounded-br-sm px-4 py-2.5 shadow-[0_4px_24px_rgba(0,0,0,0.3)] max-w-[85%]">
        <p class="text-sm font-mono text-ap-blue/90 leading-relaxed">{{ userText }}</p>
      </div>
    </div>
    <!-- Assistant bubble (left-aligned) -->
    <div v-if="assistantText" class="flex justify-start">
      <div class="backdrop-blur-xl bg-black/60 border border-white/10 rounded-xl rounded-bl-sm px-4 py-2.5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] max-w-[85%]">
        <p class="text-sm font-mono text-gray-200 leading-relaxed whitespace-pre-wrap">
          {{ assistantText }}<span v-if="streaming" class="inline-block w-[2px] h-[14px] bg-ap-orange/80 ml-0.5 align-middle animate-pulse" />
        </p>
      </div>
    </div>
  </div>
</template>
