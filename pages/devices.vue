<script setup lang="ts">
const { devices, loading, error, refresh, toggle } = useDevices()

const areaFilter = ref<string>('all')
const interactableFilter = ref<'all' | 'enabled' | 'disabled'>('all')

const areas = computed(() => {
  const set = new Set(devices.value.map((d) => d.area).filter((a) => a !== ''))
  return ['all', ...set]
})

const filtered = computed(() => {
  return devices.value.filter((d) => {
    if (areaFilter.value !== 'all' && d.area !== areaFilter.value) return false
    if (interactableFilter.value === 'enabled' && !d.interactable) return false
    if (interactableFilter.value === 'disabled' && d.interactable) return false
    return true
  })
})

const interactableCount = computed(() => devices.value.filter((d) => d.interactable).length)
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-6 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold">Devices</h1>
        <p class="text-xs text-ap-muted mt-0.5">
          {{ interactableCount }} of {{ devices.length }} interactable
        </p>
      </div>
      <button
        class="text-sm px-4 py-2 rounded border border-ap-border hover:border-ap-orange hover:text-ap-orange transition-colors disabled:opacity-40"
        :disabled="loading"
        @click="refresh"
      >
        {{ loading ? 'Syncing…' : 'Sync from HA' }}
      </button>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="text-xs text-ap-red bg-ap-panel border border-ap-red/30 rounded px-3 py-2"
    >
      {{ error }}
    </div>

    <!-- Filters -->
    <div class="flex gap-3 flex-wrap">
      <select
        v-model="areaFilter"
        class="bg-ap-panel border border-ap-border text-sm rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-ap-orange"
      >
        <option v-for="a in areas" :key="a" :value="a">
          {{ a === 'all' ? 'All areas' : a }}
        </option>
      </select>

      <select
        v-model="interactableFilter"
        class="bg-ap-panel border border-ap-border text-sm rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-ap-orange"
      >
        <option value="all">All devices</option>
        <option value="enabled">Enabled only</option>
        <option value="disabled">Disabled only</option>
      </select>
    </div>

    <!-- Loading skeleton -->
    <div
      v-if="loading && devices.length === 0"
      class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
    >
      <div
        v-for="i in 6"
        :key="i"
        class="h-32 rounded-lg bg-ap-panel border border-ap-border animate-pulse"
      />
    </div>

    <!-- Device grid -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <DeviceCard
        v-for="device in filtered"
        :key="device.deviceId"
        :device="device"
        @toggle="toggle"
      />
      <div
        v-if="filtered.length === 0"
        class="col-span-full text-center text-ap-muted text-sm py-12"
      >
        No devices match the current filters.
      </div>
    </div>
  </div>
</template>
