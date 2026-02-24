// ── ANSI escape codes ────────────────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const MAGENTA = '\x1b[35m'
const CYAN = '\x1b[36m'
const WHITE = '\x1b[37m'
const GRAY = '\x1b[90m'

// ── Scope → color mapping ────────────────────────────────────────────────────

const SCOPE_COLORS: Record<string, string> = {
  butler: `${WHITE}${BOLD}`,
  config: `${WHITE}${BOLD}`,
  ha: GREEN,
  ollama: MAGENTA,
  pipeline: CYAN,
  stt: BLUE,
  ws: GRAY,
  registry: GRAY,
  timer: YELLOW,
  news: GRAY,
}

// ── Logger interface ─────────────────────────────────────────────────────────

export interface Log {
  info(...args: unknown[]): void
  ok(...args: unknown[]): void
  fail(...args: unknown[]): void
  warn(...args: unknown[]): void
  table(data: Record<string, unknown>[] | Record<string, unknown>): void
  divider(): void
}

// ── Table helpers ──────────────────────────────────────────────────────────

const MAX_COL_WIDTH = 40
const DIVIDER_WIDTH = 40

function truncate(s: string): string {
  return s.length > MAX_COL_WIDTH ? s.slice(0, MAX_COL_WIDTH - 1) + '…' : s
}

function toRows(data: Record<string, unknown>[] | Record<string, unknown>): { headers: string[]; rows: string[][] } {
  if (Array.isArray(data)) {
    if (data.length === 0) return { headers: [], rows: [] }
    const headers = [...new Set(data.flatMap(r => Object.keys(r)))]
    const rows = data.map(r => headers.map(h => truncate(String((r as Record<string, unknown>)[h] ?? ''))))
    return { headers, rows }
  }
  const entries = Object.entries(data)
  if (entries.length === 0) return { headers: [], rows: [] }
  return {
    headers: ['Key', 'Value'],
    rows: entries.map(([k, v]) => [truncate(k), truncate(String(v ?? ''))]),
  }
}

function colWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((h, i) => {
    let max = h.length
    for (const row of rows) {
      const cell = row[i]
      if (cell !== undefined && cell.length > max) max = cell.length
    }
    return max
  })
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(w - s.length)
}

function borderLine(widths: number[], left: string, mid: string, right: string): string {
  return `${GRAY}${left}${widths.map(w => '─'.repeat(w + 2)).join(mid)}${right}${RESET}`
}

function dataLine(cells: string[], widths: number[], cellColor: string): string {
  const inner = cells.map((c, i) => {
    const w = widths[i] ?? c.length
    return ` ${cellColor}${pad(c, w)}${RESET} `
  }).join(`${GRAY}│${RESET}`)
  return `${GRAY}│${RESET}${inner}${GRAY}│${RESET}`
}

// ── Logger ───────────────────────────────────────────────────────────────────

export function createLog(scope: string): Log {
  const color = SCOPE_COLORS[scope] ?? GRAY
  const tag = `${color}[${scope}]${RESET}`

  return {
    info(...args: unknown[]) {
      console.log(tag, ...args)
    },
    ok(...args: unknown[]) {
      console.log(tag, `${GREEN}✓${RESET}`, ...args)
    },
    fail(...args: unknown[]) {
      console.error(tag, `${RED}✗${RESET}`, ...args)
    },
    warn(...args: unknown[]) {
      console.warn(tag, `${YELLOW}⚠${RESET}`, ...args)
    },
    table(data: Record<string, unknown>[] | Record<string, unknown>) {
      const { headers, rows } = toRows(data)
      if (headers.length === 0) { console.log(tag, `${GRAY}(empty)${RESET}`); return }
      const widths = colWidths(headers, rows)
      const lines: string[] = [
        borderLine(widths, '┌', '┬', '┐'),
        dataLine(headers, widths, `${color}${BOLD}`),
        borderLine(widths, '├', '┼', '┤'),
        ...rows.map(r => dataLine(r, widths, '')),
        borderLine(widths, '└', '┴', '┘'),
      ]
      for (const line of lines) console.log(tag, line)
    },
    divider() {
      console.log(tag, `${GRAY}${'─'.repeat(DIVIDER_WIDTH)}${RESET}`)
    },
  }
}
