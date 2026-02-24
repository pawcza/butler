<script setup lang="ts">
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
  PASSIVE: '#ff6600',
  HEARING: '#ffda80',
  LISTENING: '#33aaff',
  THINKING: '#ffcc40',
  EXECUTING: '#33dd4d',
  SPEAKING: '#a633ff',
}

const cursorX = ref(0)
const cursorY = ref(0)
const cursorVisible = ref(false)
const pressing = ref(false)

// Hide custom cursor on touch devices
const isTouch = ref(false)
onMounted(() => {
  isTouch.value = window.matchMedia('(pointer: coarse)').matches
})

const cursorColor = computed(() => STATE_COLORS[props.activeState] ?? '#737373')

function onMouseMove(e: MouseEvent) {
  cursorX.value = e.clientX
  cursorY.value = e.clientY
  if (!cursorVisible.value) cursorVisible.value = true
}

function onMouseLeave() {
  cursorVisible.value = false
  pressing.value = false
  emit('pressEnd')
}

function onPointerDown(e: Event) {
  pressing.value = true
  emit('pressStart', e)
}

function onPointerUp() {
  pressing.value = false
  emit('pressEnd')
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
      <GladosScene :active-state="props.activeState" :audio-energy="props.audioEnergy" />
    </TresCanvas>

    <!-- Custom cursor ring — hidden on touch devices -->
    <div
      v-if="cursorVisible && !isTouch"
      class="pointer-events-none fixed left-0 top-0 z-50"
      :style="{
        transform: `translate(${cursorX - 12}px, ${cursorY - 12}px)`,
      }"
    >
      <div
        class="h-6 w-6 rounded-full transition-transform duration-75"
        :class="pressing ? 'scale-75' : 'scale-100'"
        :style="{
          border: `1.5px solid ${cursorColor}`,
          boxShadow: `0 0 8px ${cursorColor}, 0 0 16px ${cursorColor}40`,
          ...(pressing ? { backgroundColor: `${cursorColor}30` } : {}),
        }"
      />
    </div>
  </div>
</template>
