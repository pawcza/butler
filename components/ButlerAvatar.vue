<script setup lang="ts">
import { loadGsap, getGsap } from '~/utils/gsap'

const props = withDefaults(defineProps<{
  activeState: string
  audioEnergy?: number
}>(), {
  audioEnergy: 0,
})

const emit = defineEmits<{
  pressStart: [e: Event]
  pressEnd: []
}>()

// ---------- Custom cursor ----------
const STATE_COLORS: Record<string, string> = {
  IDLE: '#737373',
  LISTENING: '#33aaff',
  THINKING: '#ffcc40',
  SPEAKING: '#ff6600',
  GRACE: '#ff6600',
}

const cursorEl = ref<HTMLElement | null>(null)
const cursorVisible = ref(false)
const pressing = ref(false)
let gsapReady = false

// Hide custom cursor on touch devices
const isTouch = ref(false)
onMounted(async () => {
  isTouch.value = window.matchMedia('(pointer: coarse)').matches
  if (isTouch.value) return
  await loadGsap()
  gsapReady = true
})

const cursorColor = computed(() => STATE_COLORS[props.activeState] ?? '#737373')

function onMouseMove(e: MouseEvent) {
  // gsap.set() — instant DOM update, no interpolation lag, bypasses Vue reactivity
  if (gsapReady && cursorEl.value) {
    const gsap = getGsap()
    if (gsap) gsap.set(cursorEl.value, { x: e.clientX - 12, y: e.clientY - 12 })
  }
  if (!cursorVisible.value) cursorVisible.value = true
}

function onMouseLeave() {
  cursorVisible.value = false
  pressing.value = false
  emit('pressEnd')
}

function onPointerDown(e: Event) {
  // Only respond to left-click — let right-click show native context menu
  if (e instanceof MouseEvent && e.button !== 0) return
  pressing.value = true
  emit('pressStart', e)
  const gsap = getGsap()
  if (gsap && cursorEl.value) {
    gsap.to(cursorEl.value.firstElementChild!, { scale: 0.75, duration: 0.1 })
  }
}

function onPointerUp() {
  pressing.value = false
  emit('pressEnd')
  const gsap = getGsap()
  if (gsap && cursorEl.value) {
    gsap.to(cursorEl.value.firstElementChild!, { scale: 1, duration: 0.2, ease: 'back.out(2)' })
  }
}
</script>

<template>
  <div
    :class="['fixed inset-0 z-0', isTouch ? 'cursor-pointer' : 'cursor-none']"
    @mousemove="onMouseMove"
    @mousedown="onPointerDown"
    @mouseup="onPointerUp"
    @mouseleave="onMouseLeave"
    @touchstart.prevent="onPointerDown"
    @touchend="onPointerUp"
  >
    <TresCanvas
      :alpha="true"
      :clear-color="'#0a0a0a'"
      window-size
      :power-preference="'high-performance'"
    >
      <ButlerScene :active-state="props.activeState" :audio-energy="props.audioEnergy" />
    </TresCanvas>

    <!-- Custom cursor ring — hidden on touch devices, positioned by GSAP quickTo -->
    <div
      v-if="!isTouch"
      ref="cursorEl"
      class="pointer-events-none fixed left-0 top-0 z-50"
      :style="{ opacity: cursorVisible ? 1 : 0 }"
    >
      <div
        class="h-6 w-6 rounded-full"
        :style="{
          border: `1.5px solid ${cursorColor}`,
          boxShadow: `0 0 8px ${cursorColor}, 0 0 16px ${cursorColor}40`,
          ...(pressing ? { backgroundColor: `${cursorColor}30` } : {}),
        }"
      />
    </div>
  </div>
</template>
