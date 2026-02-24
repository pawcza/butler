import type { ServerEvent } from '~/shared/types'

export interface BuiltInContext {
  emit: (event: ServerEvent) => void
  peerId: string
}

/** Execute a built-in tool and return a plain-text result for the LLM to interpret. */
export function executeBuiltIn(name: string, args: Record<string, unknown>, ctx: BuiltInContext): Promise<string> | string {
  switch (name) {
    case 'timer_start': {
      const durationSeconds = typeof args['duration_seconds'] === 'number'
        ? args['duration_seconds']
        : undefined
      if (durationSeconds === undefined || durationSeconds <= 0) {
        return 'Invalid or missing duration_seconds parameter.'
      }
      const label = typeof args['label'] === 'string' ? args['label'] : undefined
      const result = startTimer(durationSeconds, ctx.emit, ctx.peerId, label)
      return `Timer "${result.label}" started for ${result.durationSeconds} seconds.`
    }

    case 'timer_stop': {
      const label = typeof args['label'] === 'string' ? args['label'] : undefined
      return stopTimer(label)
    }

    case 'timer_check': {
      const label = typeof args['label'] === 'string' ? args['label'] : undefined
      return checkTimers(label)
    }

    case 'news_briefing':
      return fetchNewsBriefing()

    default:
      return `Unknown built-in tool: ${name}`
  }
}
