/** Pure, isomorphic helpers for speaking a message block sentence by sentence and following it word by word. */

/** A stretch of a block's text, as `[start, end)` character offsets. */
export interface TextRange {
  start: number
  end: number
}

/** A sentence shorter than this is read together with its neighbour, so no clip is a lone "Yes." */
const MIN_SENTENCE_CHARS = 20

/** Marks the end of a sentence: a run of terminators plus closing quotes or brackets, then whitespace or the end. */
const TERMINATOR = /[.!?…]+["'”’»)\]]*(?=\s|$)/g

/** Abbreviations that never end a sentence, even before a capital: titles, "e.g." and the like. */
const NEVER_ENDS = new Set([
  // English
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'fr', 'rev', 'gen', 'col', 'lt', 'sgt', 'capt',
  'vs', 'cf', 'viz', 'e.g', 'i.e',
  // Polish
  'np', 'tzn', 'tzw', 'ul', 'al', 'pl', 'ks', 'mgr', 'inż', 'hab', 'św', 'godz', 'ok', 'im', 'str', 'tel',
  'wg', 'ww', 'pt', 'ur', 'zm', 'hr', 'ing', 'bp', 'kard', 'płk', 'kpt', 'por', 'mjr', 'm.in',
])

/** Abbreviations that precede a number: "No. 5", "Jan. 3". Elsewhere they can end a sentence. */
const NEVER_ENDS_BEFORE_DIGIT = new Set([
  'no', 'nr', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

/** Whether the terminator run ending at `end` closes a sentence, given the text around it. */
function endsSentence(text: string, runStart: number, run: string, end: number): boolean {
  if (end >= text.length) return true
  if (/[!?]/.test(run)) return true

  const next = /\S/.exec(text.slice(end))
  if (!next) return true
  const following = text.charAt(end + next.index)
  // "…" and "." followed by lowercase continue the sentence: "3. maja", "e.g. this", "Well… maybe".
  if (/\p{Ll}/u.test(following)) return false

  const token = /[\p{L}\p{N}.]+$/u.exec(text.slice(0, runStart))?.[0] ?? ''
  const word = token.toLowerCase().replace(/^\.+|\.+$/g, '')
  if (NEVER_ENDS.has(word)) return false
  if (NEVER_ENDS_BEFORE_DIGIT.has(word) && /\p{N}/u.test(following)) return false
  // an initial, as in "J. Smith"
  if (/^\p{Lu}$/u.test(token) && run === '.') return false
  return true
}

/**
 * Splits a block's text into the sentences to speak, as character ranges (whitespace trimmed). Breaks
 * fall after `.`, `!`, `?` and `…`, but not inside decimals, after abbreviations such as "Dr." or "np.",
 * or before a lowercase continuation. A fragment shorter than 20 characters joins its neighbour.
 */
export function splitSentences(text: string): TextRange[] {
  const raw: TextRange[] = []
  let from = 0
  const push = (to: number): void => {
    const segment = text.slice(from, to)
    const lead = segment.length - segment.trimStart().length
    const trimmed = segment.trim()
    if (trimmed) raw.push({ start: from + lead, end: from + lead + trimmed.length })
    from = to
  }

  for (const match of text.matchAll(TERMINATOR)) {
    const end = match.index + match[0].length
    if (endsSentence(text, match.index, match[0].replace(/["'”’»)\]]+$/, ''), end)) push(end)
  }
  push(text.length)

  const merged: TextRange[] = []
  let open: TextRange | null = null
  for (const range of raw) {
    open = open ? { start: open.start, end: range.end } : { ...range }
    if (open.end - open.start >= MIN_SENTENCE_CHARS) {
      merged.push(open)
      open = null
    }
  }
  if (open) {
    const last = merged.pop()
    merged.push(last ? { start: last.start, end: open.end } : open)
  }
  return merged
}

/** One word of a spoken range with the stretch of the clip it is estimated to fill, in seconds. */
export interface WordTiming extends TextRange {
  from: number
  to: number
}

/** Extra length, in letters, that the pause after a word is worth. */
const PAUSE_WEIGHT = { weak: 2.5, strong: 5 } as const

/**
 * Estimates when each word of `range` is spoken in a clip lasting `duration` seconds. No engine here
 * reports word times, so the duration is spread over the words by their length, with a small pause
 * after commas and a longer one after sentence ends (but none at the very end of the clip).
 * The timings are contiguous: a word lasts until the next one starts.
 */
export function estimateWordTimings(text: string, range: TextRange, duration: number): WordTiming[] {
  const words: Array<TextRange & { weight: number }> = []
  for (const match of text.slice(range.start, range.end).matchAll(/\S+/g)) {
    const token = match[0]
    const start = range.start + match.index
    const letters = token.match(/[\p{L}\p{N}]/gu)?.length ?? 0
    const pause = /[,;:]["'”’)\]]*$/.test(token)
      ? PAUSE_WEIGHT.weak
      : /[.!?…]["'”’»)\]]*$/.test(token) ? PAUSE_WEIGHT.strong : 0
    const previous = words.at(-1)
    if (letters === 0) {
      // a dash or a stray mark has no sound of its own, only a short pause after the word before it
      if (previous) previous.weight += PAUSE_WEIGHT.weak
      continue
    }
    words.push({ start, end: start + token.length, weight: letters + pause })
  }
  const last = words.at(-1)
  if (last) last.weight -= /[.!?…]["'”’»)\]]*$/.test(text.slice(last.start, last.end)) ? PAUSE_WEIGHT.strong : 0

  const total = words.reduce((sum, word) => sum + word.weight, 0)
  let at = 0
  return words.map((word) => {
    const from = total > 0 ? (at / total) * duration : 0
    at += word.weight
    return { start: word.start, end: word.end, from, to: total > 0 ? (at / total) * duration : duration }
  })
}

/** The index of the word being spoken `elapsed` seconds into the clip, or -1 when there are no words. */
export function wordIndexAt(timings: readonly WordTiming[], elapsed: number): number {
  let index = timings.length - 1
  for (let i = 0; i < timings.length; i++) {
    if ((timings[i]?.to ?? 0) > elapsed) {
      index = i
      break
    }
  }
  return index
}
