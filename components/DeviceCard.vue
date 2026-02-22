<script setup lang="ts">
import type { Device } from '~/shared/types'

const props = defineProps<{ device: Device }>()
const emit = defineEmits<{ toggle: [deviceId: string, interactable: boolean] }>()

const domainColor: Record<string, string> = {
  light: 'text-yellow-400',
  switch: 'text-ap-blue',
  cover: 'text-purple-400',
  climate: 'text-red-400',
}
</script>

<template>
  <div
    class="rounded-lg border p-4 flex flex-col gap-3 transition-opacity"
    :class="device.interactable ? 'border-ap-border bg-ap-panel' : 'border-ap-border/40 bg-ap-bg opacity-60'"
  >
    <!-- Header: name + toggle -->
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="font-medium text-sm truncate">{{ device.name }}</p>
        <p class="text-xs text-ap-orange truncate mt-0.5">{{ device.area || '— no area —' }}</p>
        <p
          v-if="device.manufacturer || device.model"
          class="text-xs text-ap-muted/60 truncate mt-0.5"
        >
          {{ [device.manufacturer, device.model].filter(Boolean).join(' · ') }}
        </p>
      </div>

      <!-- Toggle switch -->
      <button
        class="relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200"
        :class="device.interactable ? 'bg-ap-orange' : 'bg-ap-muted'"
        :aria-label="device.interactable ? 'Disable device' : 'Enable device'"
        @click="emit('toggle', device.deviceId, !device.interactable)"
      >
        <span
          class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200"
          :class="device.interactable ? 'translate-x-4' : 'translate-x-0'"
        />
      </button>
    </div>

    <!-- Controllable entities -->
    <div class="flex flex-col gap-1 border-t border-ap-border/40 pt-2">
      <div
        v-for="entity in device.entities"
        :key="entity.entityId"
        class="flex items-center gap-2 text-xs"
      >
        <span
          class="shrink-0 px-1.5 py-0.5 rounded font-mono uppercase tracking-wider bg-ap-bg"
          :class="domainColor[entity.domain] ?? 'text-gray-400'"
        >
          {{ entity.domain }}
        </span>
        <span class="truncate flex-1 text-ap-muted">{{ entity.friendlyName }}</span>
        <span class="shrink-0 text-ap-muted/60">{{ entity.state }}</span>
      </div>
    </div>
  </div>
</template>
