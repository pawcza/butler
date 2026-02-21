import type { Entity } from '~/shared/types'

export function useEntities() {
  const entities = ref<Entity[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchEntities(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      entities.value = await $fetch<Entity[]>('/api/entities')
    } catch {
      error.value = 'Failed to load entities'
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await $fetch('/api/entities/refresh', { method: 'POST' })
      await fetchEntities()
    } catch {
      error.value = 'Failed to sync from Home Assistant'
    } finally {
      loading.value = false
    }
  }

  async function toggle(entityId: string, interactable: boolean): Promise<void> {
    const entity = entities.value.find((e) => e.entityId === entityId)
    if (entity) entity.interactable = interactable // optimistic update

    try {
      await $fetch(`/api/entities/${encodeURIComponent(entityId)}`, {
        method: 'PATCH',
        body: { interactable },
      })
    } catch {
      if (entity) entity.interactable = !interactable // revert on failure
      error.value = 'Failed to update entity'
    }
  }

  onMounted(fetchEntities)

  return { entities, loading, error, refresh, toggle }
}
