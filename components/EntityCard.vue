<script setup lang="ts">
import type { Entity } from '~/shared/types'

const props = defineProps<{ entity: Entity }>()
const emit = defineEmits<{ toggle: [entityId: string, interactable: boolean] }>()

const domainColor: Record<string, string> = {
  light: 'text-yellow-400',
  switch: 'text-ap-blue',
  cover: 'text-purple-400',
  climate: 'text-red-400',
  scene: 'text-green-400',
}
</script>

<template>
  <div
    class="rounded-lg border p-4 flex flex-col gap-3 transition-colors"
    :class="entity.interactable ? 'border-ap-border bg-ap-panel' : 'border-ap-border/40 bg-ap-bg opacity-60'"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="font-medium text-sm truncate">{{ entity.friendlyName }}</p>
        <p class="text-xs text-ap-muted truncate mt-0.5">{{ entity.entityId }}</p>
      </div>
      <!-- Toggle switch -->
      <button
        class="relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200"
        :class="entity.interactable ? 'bg-ap-orange' : 'bg-ap-muted'"
        :aria-label="entity.interactable ? 'Disable entity' : 'Enable entity'"
        @click="emit('toggle', entity.entityId, !entity.interactable)"
      >
        <span
          class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200"
          :class="entity.interactable ? 'translate-x-4' : 'translate-x-0'"
        />
      </button>
    </div>

    <div class="flex items-center gap-2 text-xs">
      <span
        class="px-1.5 py-0.5 rounded font-mono uppercase tracking-wider bg-ap-bg"
        :class="domainColor[entity.domain] ?? 'text-gray-400'"
      >
        {{ entity.domain }}
      </span>
      <span v-if="entity.area" class="text-ap-muted">{{ entity.area }}</span>
      <span class="ml-auto text-ap-muted">{{ entity.state }}</span>
    </div>
  </div>
</template>
