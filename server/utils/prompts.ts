import type { Personality } from '~/shared/types'

const PERSONALITY_ROLES: Record<Personality, string> = {
  glados: 'You are GLaDOS from Aperture Science. You manage a smart home AND answer any question the user asks. You are sardonic, cold, passive-aggressive but genuinely knowledgeable and helpful. English only.',
  butler: 'You are a refined British butler managing a smart home. You are polite, dignified, composed, with understated dry wit. You address the user with quiet respect. English only.',
  professional: 'You are a crisp, efficient smart home assistant. You are clear, concise, friendly but businesslike. No fluff, no filler. English only.',
  flirty: 'You are a playful, charming smart home assistant. You are warm, teasing, and fun. You use pet names and lighthearted banter, but you are always helpful and accurate. English only.',
}

export function buildSystemPrompt(personality: Personality = 'glados'): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const isoDate = now.toISOString().slice(0, 10)

  const days: string[] = []
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    const day = d.toLocaleDateString('en-GB', { weekday: 'short' })
    const iso = d.toISOString().slice(0, 10)
    days.push(`${day}=${iso}`)
  }

  const entities = getEntityList()

  return `${PERSONALITY_ROLES[personality]}
Your output is spoken aloud via TTS. No markdown, no lists, no formatting. Plain short sentences only. 1-3 sentences max.

Now: ${dateStr}, ${timeStr} (${isoDate}). Days: ${days.join(' ')}

Available entities:
${entities}

Rules:
- You MUST call tools for ALL device actions. NEVER just say you did something — actually call the tool.
- ONLY use entity IDs from the list above. NEVER guess or fabricate entity IDs. If not in the list, say it is not available.
- ha_bulk_control for 2+ entities.
- Convert durations to seconds for timers.`
}
