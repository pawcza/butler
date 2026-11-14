/** Pure, isomorphic text helpers shared between server and client. */
import type { TextRange } from './speech'

/** Accepted conversation id shape. Ids become file names, so this also keeps paths inside the store. */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Safe stringification for logs/UI — strings pass through, objects JSON-encode, unserializable fall back to String(). */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Collapse whitespace and clip to `max` chars with an ellipsis marker. */
export function truncatePreview(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** The words after the wake word, or null if it wasn't said. Empty when it was said alone. */
export function matchWakeWord(heard: string, wakeWord: string): string | null {
  const at = heard.toLowerCase().indexOf(wakeWord.toLowerCase())
  if (at === -1) return null
  return heard.slice(at + wakeWord.length).replace(/^[,.\s!?]+/, '').trim()
}

/** Letters and common words that mark a language. Words that also exist in English are left out. */
const LANGUAGE_MARKERS: Record<string, { letters: RegExp; words: ReadonlySet<string> }> = {
  pl: {
    letters: /[ąćęłńśźż]/i,
    words: new Set([
      'jest', 'jestem', 'nie', 'tak', 'czy', 'jak', 'oraz', 'albo', 'dla', 'przez', 'przy', 'pani',
      'panie', 'prosze', 'dobrze', 'oczywiscie', 'teraz', 'tylko', 'bardzo', 'jeszcze', 'tego', 'tym',
      'tej', 'kto', 'gdzie', 'kiedy', 'ile', 'masz', 'sie', 'juz', 'moze', 'mozna', 'bedzie', 'bylo',
    ]),
  },
}

/**
 * Which of `candidates` the text is written in, or null when none stands out. A marker letter
 * settles it; without one, two marker words do.
 */
export function detectLanguage(text: string, candidates: readonly string[]): string | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  for (const language of candidates) {
    const markers = LANGUAGE_MARKERS[language]
    if (!markers) continue
    if (markers.letters.test(text)) return language
    if (words.filter((word) => markers.words.has(word)).length >= 2) return language
  }
  return null
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch)
}

/** A stretch of the raw text to wrap in `<span class="className">`, as `[start, end)` character offsets. */
export interface TextMark {
  start: number
  end: number
  className: string
}

// Private-use characters carry the marks through the markdown rewrite, which would otherwise shift offsets.
const MARK_OPEN = ''
const MARK_CLOSE = ''
const MARK_CLASS_BASE = 0xE100
const MARK_PRIVATE_USE = /[--]/

/** The `](https://…)` tail of every markdown link in the raw text. */
function linkTails(text: string): TextRange[] {
  return [...text.matchAll(/\]\(https?:\/\/[^\s)]+\)/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

/**
 * Pulls a mark in from markdown syntax, so the span it becomes sits inside the element the words
 * belong to: after `**`, `_`, a backtick or `[` at the start, before them at the end, and before
 * the `](url)` of a link. A mark with nothing left is dropped.
 */
function settleMark(text: string, mark: TextMark, tails: readonly TextRange[]): TextMark | null {
  let { start, end } = mark
  const tail = tails.find((t) => end > t.start && end <= t.end)
  if (tail) end = tail.start
  if (tails.some((t) => start >= t.start && start < t.end)) return null
  while (start < end && '*_`['.includes(text.charAt(start))) start++
  while (end > start && '*_`'.includes(text.charAt(end - 1))) end--
  return end > start ? { ...mark, start, end } : null
}

/**
 * Escape HTML, then render the common inline markdown the LLM emits: bold, italic, inline code, links.
 * Block-level markdown (lists, headings, code blocks) is intentionally out of scope — our assistant text is short.
 * Links only match http(s) URLs so `javascript:` / `data:` schemes can't sneak through.
 *
 * `marks` wrap stretches of the raw text in a span with a class, however the markdown cuts through them,
 * for highlighting spoken words. They must be sorted and must not overlap.
 */
export function renderInlineMarkdown(text: string, marks: readonly TextMark[] = []): string {
  const tails = marks.length > 0 ? linkTails(text) : []
  const settled = MARK_PRIVATE_USE.test(text)
    ? []
    : marks.map((mark) => settleMark(text, mark, tails)).filter((mark): mark is TextMark => mark !== null)
  const classes = [...new Set(settled.map((mark) => mark.className))]

  let marked = ''
  let at = 0
  for (const mark of settled) {
    const classIndex = String.fromCharCode(MARK_CLASS_BASE + classes.indexOf(mark.className))
    marked += text.slice(at, mark.start) + MARK_OPEN + classIndex + text.slice(mark.start, mark.end) + MARK_CLOSE
    at = mark.end
  }
  marked += text.slice(at)

  let s = escapeHtml(marked)
  s = s.replace(/\*\*([^\n*][^\n]*?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^\n_][^\n]*?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*(?!\s)([^\n*]+?)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_])_(?!\s)([^\n_]+?)_(?!_)/g, '$1<em>$2</em>')
  s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>')
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
  )
  if (settled.length > 0) {
    s = s.replace(/([-])/g, (_, c: string) => `<span class="${escapeHtml(classes[c.charCodeAt(0) - MARK_CLASS_BASE] ?? '')}">`)
    s = s.replaceAll(MARK_CLOSE, '</span>')
  }
  return s
}
