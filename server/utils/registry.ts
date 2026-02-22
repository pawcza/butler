import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolRegistry, Device, ControlEntity, Tool } from '~/shared/types'

const TOOL_DEFINITIONS: Tool[] = [
  { name: 'turn_on_light',   description: 'Turn on a light entity',                                                    domain: 'light',   service: 'turn_on' },
  { name: 'turn_off_light',  description: 'Turn off a light entity',                                                   domain: 'light',   service: 'turn_off' },
  { name: 'open_cover',      description: 'Open a cover, blind, or shutter',                                           domain: 'cover',   service: 'open_cover' },
  { name: 'close_cover',     description: 'Close a cover, blind, or shutter',                                          domain: 'cover',   service: 'close_cover' },
  { name: 'set_temperature', description: 'Set thermostat temperature — requires extra param: temperature (number)',    domain: 'climate', service: 'set_temperature' },
  { name: 'turn_on_switch',  description: 'Turn on a switch entity',                                                   domain: 'switch',  service: 'turn_on' },
  { name: 'turn_off_switch', description: 'Turn off a switch entity',                                                  domain: 'switch',  service: 'turn_off' },
]

const SUPPORTED_DOMAINS = new Set(['light', 'cover', 'climate', 'switch'])

const DATA_PATH = join(process.cwd(), 'data', 'devices.json')

type DeviceConfig = Record<string, { interactable: boolean }>

function readDeviceConfig(): DeviceConfig {
  if (!existsSync(DATA_PATH)) return {}
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as DeviceConfig
  } catch {
    return {}
  }
}

function writeDeviceConfig(cfg: DeviceConfig): void {
  const dir = join(process.cwd(), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(DATA_PATH, JSON.stringify(cfg, null, 2))
}

function domainOf(entityId: string): string {
  return entityId.split('.')[0] ?? ''
}

let registry: ToolRegistry = { tools: [], devices: [] }

export async function buildRegistry(): Promise<void> {
  const [haDevices, haEntities, haAreas, states] = await Promise.all([
    getDevices(),
    getEntityRegistry(),
    getAreas(),
    getStates(),
  ])

  // Build lookup maps
  const areaNameMap = new Map<string, string>(haAreas.map((a) => [a.area_id, a.name]))
  const stateMap = new Map<string, string>(states.map((s) => [s.entity_id, s.state]))
  const friendlyNameMap = new Map<string, string>(
    states
      .filter((s) => typeof s.attributes.friendly_name === 'string')
      .map((s) => [s.entity_id, s.attributes.friendly_name as string]),
  )

  // Group controllable, non-disabled entities by device_id
  const entitiesByDevice = new Map<string, ControlEntity[]>()
  for (const entry of haEntities) {
    if (entry.disabled_by !== null) continue
    if (!entry.device_id) continue
    const domain = domainOf(entry.entity_id)
    if (!SUPPORTED_DOMAINS.has(domain)) continue

    const list = entitiesByDevice.get(entry.device_id) ?? []
    list.push({
      entityId: entry.entity_id,
      domain,
      state: stateMap.get(entry.entity_id) ?? 'unknown',
      friendlyName: friendlyNameMap.get(entry.entity_id) ?? entry.entity_id,
    })
    entitiesByDevice.set(entry.device_id, list)
  }

  const deviceConfig = readDeviceConfig()
  const updatedConfig: DeviceConfig = { ...deviceConfig }
  const devices: Device[] = []

  for (const haDevice of haDevices) {
    const entities = entitiesByDevice.get(haDevice.id)
    if (!entities || entities.length === 0) continue

    const areaName = haDevice.area_id != null ? (areaNameMap.get(haDevice.area_id) ?? '') : ''
    const existing = deviceConfig[haDevice.id]
    // Default: interactable if the device has an area
    const interactable = existing?.interactable ?? (haDevice.area_id != null && haDevice.area_id !== '')

    if (!(haDevice.id in updatedConfig)) {
      updatedConfig[haDevice.id] = { interactable }
    }

    devices.push({
      deviceId: haDevice.id,
      name: haDevice.name_by_user ?? haDevice.name ?? haDevice.id,
      area: areaName,
      entities,
      interactable,
      ...(haDevice.manufacturer != null ? { manufacturer: haDevice.manufacturer } : {}),
      ...(haDevice.model != null ? { model: haDevice.model } : {}),
    })
  }

  writeDeviceConfig(updatedConfig)
  registry = { tools: TOOL_DEFINITIONS, devices }

  const interactableCount = devices.filter((d) => d.interactable).length
  console.log(
    `[registry] ${TOOL_DEFINITIONS.length} tools, ${devices.length} devices (${interactableCount} interactable)`,
  )
}

export function getRegistry(): ToolRegistry {
  return registry
}

/** Returns only interactable devices — used by the pipeline for system prompt + validation. */
export function getInteractableRegistry(): ToolRegistry {
  return {
    tools: registry.tools,
    devices: registry.devices.filter((d) => d.interactable),
  }
}

/** Persists the interactable flag for one device and updates the in-memory registry. */
export function setDeviceInteractable(deviceId: string, interactable: boolean): boolean {
  const device = registry.devices.find((d) => d.deviceId === deviceId)
  if (!device) return false

  device.interactable = interactable

  const cfg = readDeviceConfig()
  cfg[deviceId] = { interactable }
  writeDeviceConfig(cfg)
  return true
}

/** Returns true only if the entity belongs to an interactable device. Used by validator. */
export function isValidEntity(entityId: string): boolean {
  return registry.devices.some(
    (d) => d.interactable && d.entities.some((e) => e.entityId === entityId),
  )
}

export function isValidTool(name: string): boolean {
  return registry.tools.some((t) => t.name === name)
}
