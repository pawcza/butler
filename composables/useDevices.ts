import type { Device } from '~/shared/types'

export function useDevices() {
  const devices = ref<Device[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchDevices(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      devices.value = await $fetch<Device[]>('/api/devices')
    } catch {
      error.value = 'Failed to load devices'
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await $fetch('/api/devices/refresh', { method: 'POST' })
      await fetchDevices()
    } catch {
      error.value = 'Failed to sync from Home Assistant'
    } finally {
      loading.value = false
    }
  }

  async function toggle(deviceId: string, interactable: boolean): Promise<void> {
    const device = devices.value.find((d) => d.deviceId === deviceId)
    if (device) device.interactable = interactable // optimistic

    try {
      await $fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        body: { interactable },
      })
    } catch {
      if (device) device.interactable = !interactable // revert
      error.value = 'Failed to update device'
    }
  }

  onMounted(fetchDevices)

  return { devices, loading, error, refresh, toggle }
}
