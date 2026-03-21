<script setup lang="ts">
import { useEffectPmndrs } from '@tresjs/post-processing'
import { HeatHazeEffect } from './HeatHazeEffect'

const props = withDefaults(defineProps<{
  intensity?: number
  time?: number
  falloff?: number
}>(), {
  intensity: 0.005,
  time: 0,
  falloff: 4.0,
})

const { pass, effect } = useEffectPmndrs(
  () => new HeatHazeEffect({
    intensity: props.intensity,
    falloff: props.falloff,
  }),
  props,
)

watch(() => props.intensity, (v) => { const e = effect.value as HeatHazeEffect | null; if (e) e.intensity = v })
watch(() => props.time, (v) => { const e = effect.value as HeatHazeEffect | null; if (e) e.time = v })
watch(() => props.falloff, (v) => { const e = effect.value as HeatHazeEffect | null; if (e) e.falloff = v })

defineExpose({ pass, effect })
</script>

<template>
  <slot />
</template>
