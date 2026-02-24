import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerEvent } from '~/shared/types'

type Emitter = (event: ServerEvent) => void

interface TimerEntry {
  label: string
  durationSeconds: number
  startedAt: number
  handle: ReturnType<typeof setTimeout>
  emit: Emitter
  peerId: string
}

const timers = new Map<string, TimerEntry>()
let autoCounter = 0

function nextAutoLabel(): string {
  autoCounter++
  return `Timer ${autoCounter}`
}

let ringBase64: string | null = null
function getRingAudioBase64(): string {
  if (ringBase64 === null) {
    const ringPath = join(process.cwd(), 'public', 'ring.mp3')
    ringBase64 = readFileSync(ringPath).toString('base64')
  }
  return ringBase64
}

function onTimerExpired(label: string, emit: Emitter): void {
  timers.delete(label)
  console.log(`[timer] "${label}" expired`)

  try {
    const audioData = getRingAudioBase64()
    emit({ type: 'audio', data: audioData, format: 'mp3' })
  } catch (err) {
    console.error('[timer] failed to send ring sound:', err)
  }

  emit({ type: 'response', text: `Timer "${label}" has finished.` })
}

export function startTimer(
  durationSeconds: number,
  emit: Emitter,
  peerId: string,
  label?: string,
): { label: string; durationSeconds: number } {
  const timerLabel = label?.trim() || nextAutoLabel()

  const existing = timers.get(timerLabel)
  if (existing) {
    clearTimeout(existing.handle)
    timers.delete(timerLabel)
  }

  const handle = setTimeout(() => {
    onTimerExpired(timerLabel, emit)
  }, durationSeconds * 1000)

  timers.set(timerLabel, {
    label: timerLabel,
    durationSeconds,
    startedAt: Date.now(),
    handle,
    emit,
    peerId,
  })

  console.log(`[timer] started "${timerLabel}" for ${durationSeconds}s`)
  return { label: timerLabel, durationSeconds }
}

export function stopTimer(label?: string): string {
  if (label) {
    const entry = timers.get(label)
    if (!entry) return `No active timer named "${label}".`
    clearTimeout(entry.handle)
    timers.delete(label)
    return `Timer "${label}" cancelled.`
  }

  if (timers.size === 0) return 'No active timers to cancel.'
  const count = timers.size
  for (const [, entry] of timers) {
    clearTimeout(entry.handle)
  }
  timers.clear()
  return `Cancelled ${count} timer(s).`
}

export function checkTimers(label?: string): string {
  if (label) {
    const entry = timers.get(label)
    if (!entry) return `No active timer named "${label}".`
    const elapsed = (Date.now() - entry.startedAt) / 1000
    const remaining = Math.max(0, entry.durationSeconds - elapsed)
    return formatRemaining(entry.label, remaining)
  }

  if (timers.size === 0) return 'No active timers.'

  const lines: string[] = []
  for (const [, entry] of timers) {
    const elapsed = (Date.now() - entry.startedAt) / 1000
    const remaining = Math.max(0, entry.durationSeconds - elapsed)
    lines.push(formatRemaining(entry.label, remaining))
  }
  return lines.join('\n')
}

export function clearTimersForPeer(peerId: string): void {
  for (const [label, entry] of timers) {
    if (entry.peerId === peerId) {
      clearTimeout(entry.handle)
      timers.delete(label)
      console.log(`[timer] cleared "${label}" — peer ${peerId} disconnected`)
    }
  }
}

function formatRemaining(label: string, seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m > 0) {
    return `"${label}": ${m} minute(s) and ${s} second(s) remaining.`
  }
  return `"${label}": ${s} second(s) remaining.`
}
