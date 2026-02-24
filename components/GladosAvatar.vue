<script setup lang="ts">
const props = defineProps<{
  activeState: string
}>()

const emit = defineEmits<{
  pressStart: [e: Event]
  pressEnd: []
}>()

function onPointerDown(e: Event) {
  emit('pressStart', e)
}

function onPointerUp() {
  emit('pressEnd')
}
</script>

<template>
  <div
    class="fixed inset-0 z-0 cursor-pointer"
    @mousedown="onPointerDown"
    @mouseup="onPointerUp"
    @mouseleave="onPointerUp"
    @touchstart.prevent="onPointerDown"
    @touchend="onPointerUp"
  >
    <TresCanvas
      :alpha="true"
      :clear-color="'#0a0a0a'"
      window-size
      :power-preference="'high-performance'"
    >
      <GladosScene :active-state="props.activeState" />
    </TresCanvas>
  </div>
</template>
