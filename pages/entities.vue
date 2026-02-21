<script setup lang="ts">
const { entities, loading, error, refresh, toggle } = useEntities()

const domainFilter = ref<string>('all')
const interactableFilter = ref<'all' | 'enabled' | 'disabled'>('all')

const domains = computed(() => {
  const set = new Set(entities.value.map((e) => e.domain))
  return ['all', ...set]
})

const filtered = computed(() => {
  return entities.value.filter((e) => {
    if (domainFilter.value !== 'all' && e.domain !== domainFilter.value) return false
    if (interactableFilter.value === 'enabled' && !e.interactable) return false
    if (interactableFilter.value === 'disabled' && e.interactable) return false
    return true
  })
})

const interactableCount = computed(() => entities.value.filter((e) => e.interactable).length)
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-6 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold">Entities</h1>
        <p class="text-xs text-ap-muted mt-0.5">
          {{ interactableCount }} of {{ entities.length }} interactable
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
    <div v-if="error" class="text-xs text-ap-red bg-ap-panel border border-ap-red/30 rounded px-3 py-2">
      {{ error }}
    </div>

    <!-- Filters -->
    <div class="flex gap-3 flex-wrap">
      <select
        v-model="domainFilter"
        class="bg-ap-panel border border-ap-border text-sm rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-ap-orange"
      >
        <option v-for="d in domains" :key="d" :value="d">
          {{ d === 'all' ? 'All domains' : d }}
        </option>
      </select>

      <select
        v-model="interactableFilter"
        class="bg-ap-panel border border-ap-border text-sm rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-ap-orange"
      >
        <option value="all">All entities</option>
        <option value="enabled">Enabled only</option>
        <option value="disabled">Disabled only</option>
      </select>
    </div>

    <!-- Loading skeleton -->
    <div v-if="loading && entities.length === 0" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <div
        v-for="i in 6"
        :key="i"
        class="h-24 rounded-lg bg-ap-panel border border-ap-border animate-pulse"
      />
    </div>

    <!-- Entity grid -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <EntityCard
        v-for="entity in filtered"
        :key="entity.entityId"
        :entity="entity"
        @toggle="toggle"
      />
      <div v-if="filtered.length === 0" class="col-span-full text-center text-ap-muted text-sm py-12">
        No entities match the current filters.
      </div>
    </div>
  </div>
</template>
