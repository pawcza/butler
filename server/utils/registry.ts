import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolRegistry, Entity, Tool } from '~/shared/types'

const TOOL_DEFINITIONS: Tool[] = [
  { name: 'turn_on_light',   description: 'Turn on a light entity',                                          domain: 'light',   service: 'turn_on' },
  { name: 'turn_off_light',  description: 'Turn off a light entity',                                         domain: 'light',   service: 'turn_off' },
  { name: 'open_cover',      description: 'Open a cover, blind, or shutter',                                 domain: 'cover',   service: 'open_cover' },
  { name: 'close_cover',     description: 'Close a cover, blind, or shutter',                                domain: 'cover',   service: 'close_cover' },
  { name: 'set_temperature', description: 'Set thermostat temperature — requires extra param: temperature (number)', domain: 'climate', service: 'set_temperature' },
  { name: 'activate_scene',  description: 'Activate a Home Assistant scene',                                 domain: 'scene',   service: 'turn_on' },
  { name: 'turn_on_switch',  description: 'Turn on a switch entity',                                         domain: 'switch',  service: 'turn_on' },
  { name: 'turn_off_switch', description: 'Turn off a switch entity',                                        domain: 'switch',  service: 'turn_off' },
]

const SUPPORTED_DOMAINS = new Set(['light', 'cover', 'climate', 'scene', 'switch'])

const DATA_PATH = join(process.cwd(), 'data', 'entities.json')

type EntityConfig = Record<string, { interactable: boolean }>

function readEntityConfig(): EntityConfig {
  if (!existsSync(DATA_PATH)) return {}
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as EntityConfig
  } catch {
    return {}
  }
}

function writeEntityConfig(cfg: EntityConfig): void {
  const dir = join(process.cwd(), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(DATA_PATH, JSON.stringify(cfg, null, 2))
}

function domainOf(entityId: string): string {
  return entityId.split('.')[0] ?? ''
}

let registry: ToolRegistry = { tools: [], entities: [] }

export async function buildRegistry(): Promise<void> {
  const [states, areaMap] = await Promise.all([
    getStates(),
    getEntityAreas().catch((err: unknown) => {
      console.warn(`[registry] Could not fetch areas: ${err instanceof Error ? err.message : err}`)
      return {} as Record<string, string>
    }),
  ])

  const entityConfig = readEntityConfig()
  const updatedConfig: EntityConfig = { ...entityConfig }

  const entities: Entity[] = states
    .filter((s) => SUPPORTED_DOMAINS.has(domainOf(s.entity_id)))
    .map((s) => {
      const entityId = s.entity_id
      const existing = entityConfig[entityId]
      const interactable = existing?.interactable ?? true

      if (!(entityId in updatedConfig)) {
        updatedConfig[entityId] = { interactable: true }
      }

      const areaName = areaMap[entityId]
      return {
        entityId,
        domain: domainOf(entityId),
        friendlyName:
          typeof s.attributes.friendly_name === 'string' ? s.attributes.friendly_name : entityId,
        state: s.state,
        ...(areaName !== undefined ? { area: areaName } : {}),
        interactable,
      }
    })

  writeEntityConfig(updatedConfig)
  registry = { tools: TOOL_DEFINITIONS, entities }

  const interactableCount = entities.filter((e) => e.interactable).length
  console.log(
    `[registry] ${TOOL_DEFINITIONS.length} tools, ${entities.length} entities (${interactableCount} interactable)`,
  )
}

export function getRegistry(): ToolRegistry {
  return registry
}

/** Returns only interactable entities — used by the pipeline for system prompt + validation. */
export function getInteractableRegistry(): ToolRegistry {
  return {
    tools: registry.tools,
    entities: registry.entities.filter((e) => e.interactable),
  }
}

/** Persists the interactable flag for one entity and updates the in-memory registry. */
export function setEntityInteractable(entityId: string, interactable: boolean): boolean {
  const entity = registry.entities.find((e) => e.entityId === entityId)
  if (!entity) return false

  entity.interactable = interactable

  const cfg = readEntityConfig()
  cfg[entityId] = { interactable }
  writeEntityConfig(cfg)
  return true
}

/** Returns true only if the entity exists AND is interactable. Used by validator. */
export function isValidEntity(entityId: string): boolean {
  return registry.entities.some((e) => e.entityId === entityId && e.interactable)
}

export function isValidTool(name: string): boolean {
  return registry.tools.some((t) => t.name === name)
}
