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

/** Stands in for dropped markup while later passes scan the text, so it can't open or close anything. */
const DROPPED = '\u0000'

/** Polish months in the genitive: "3. maja" is a date, not a list item. */
const POLISH_MONTH = '(?:stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia)'

/**
 * Which characters of a block's text are read aloud: `true` for a spoken one, `false` for markdown
 * syntax (emphasis marks, backticks, the `[` and `](url)` around a link label, list and heading
 * markers). The text itself is never changed, so offsets into it stay valid.
 */
export function spokenMask(text: string): boolean[] {
  const spoken = new Array<boolean>(text.length).fill(true)
  let scan = text
  const drop = (from: number, to: number): void => {
    for (let i = from; i < to; i++) spoken[i] = false
    scan = scan.slice(0, from) + DROPPED.repeat(to - from) + scan.slice(to)
  }
  /** Drops `open` characters at the start of each match and `close` at its end. */
  const dropAround = (pattern: RegExp, open: number, close: number): void => {
    for (const m of [...scan.matchAll(pattern)]) {
      drop(m.index, m.index + open)
      drop(m.index + m[0].length - close, m.index + m[0].length)
    }
  }
  const dropWhole = (pattern: RegExp): void => {
    for (const m of [...scan.matchAll(pattern)]) drop(m.index, m.index + m[0].length)
  }

  dropWhole(/^[ \t]*(?:`{3,}[^\n`]*|(?:[-*_][ \t]*){3,})$/gm)
  dropWhole(new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]+|[-*+•][ \\t]+|\\d{1,3}[.)][ \\t]+(?!${POLISH_MONTH})|>[ \\t]*)`, 'gmu'))
  // [label](url) and ![alt](url): the label stays
  for (const m of [...scan.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g)]) {
    const labelStart = m.index + (m[1]?.length ?? 0) + 1
    drop(m.index, labelStart)
    drop(labelStart + (m[2]?.length ?? 0), m.index + m[0].length)
  }
  for (const m of [...scan.matchAll(/(`+)([^`\n]+?)\1(?!`)/g)]) {
    const mark = m[1]?.length ?? 1
    drop(m.index, m.index + mark)
    drop(m.index + m[0].length - mark, m.index + m[0].length)
  }
  dropWhole(/`+/g)
  dropAround(/\*\*(?=\S)[^\n]*?\S\*\*/g, 2, 2)
  dropAround(/(?<![\p{L}\p{N}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}_])/gu, 2, 2)
  dropAround(/~~(?=\S)[^\n]*?\S~~/g, 2, 2)
  // a lone * or _ is emphasis only when it hugs the words, and an underscore only at a word edge: snake_case stays
  dropAround(/(?<![*\p{L}\p{N}])\*(?=[^\s*])[^\n*]*?[^\s*]\*(?![*\p{L}\p{N}])/gu, 1, 1)
  dropAround(/(?<![\p{L}\p{N}_])_(?=[^\s_])[^\n_]*?[^\s_]_(?![\p{L}\p{N}_])/gu, 1, 1)
  return spoken
}

/** What the speech engine is given for `range` of `text`: its spoken characters, whitespace collapsed. */
export function spokenText(text: string, mask: readonly boolean[], range: TextRange): string {
  let said = ''
  for (let i = range.start; i < range.end; i++) if (mask[i]) said += text.charAt(i)
  return said.replace(/\s+/g, ' ').trim()
}

/** A first sentence at least this long is read in two clips, so the first one starts sooner. */
const LONG_FIRST_SENTENCE_CHARS = 90
/** Neither clip of a split sentence may be shorter than this. */
const MIN_CLAUSE_CHARS = 25

/**
 * The first sentence of a turn, split at the clause boundary nearest its middle when it is long: a
 * comma, semicolon or colon followed by a space, or a dash. Never inside brackets or parentheses, and
 * not after an abbreviation; "1,000" and "10:30" have no space after the mark, so they stay whole. No
 * piece is under 25 characters. Anything else comes back as it is.
 */
export function splitFirstSentence(text: string, range: TextRange, mask: readonly boolean[] = spokenMask(text)): TextRange[] {
  const length = spokenText(text, mask, range).length
  if (length < LONG_FIRST_SENTENCE_CHARS) return [range]

  // the middle is of what is spoken: a long url in a link doesn't pull it off centre
  let heard = 0
  for (let i = range.start; i < range.end; i++) if (mask[i]) heard += 1
  let before = 0
  let best: { first: TextRange; second: TextRange; distance: number } | null = null
  let depth = 0
  for (let i = range.start; i < range.end; i++) {
    const ch = text.charAt(i)
    if (mask[i]) before += 1
    if ('([{'.includes(ch)) depth += 1
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    if (depth > 0 || !mask[i]) continue

    let firstEnd: number
    if (',;:'.includes(ch)) {
      if (!/\s/.test(text.charAt(i + 1)) || text.charAt(i - 1) === '.') continue
      const word = /[\p{L}\p{N}.]+$/u.exec(text.slice(range.start, i))?.[0] ?? ''
      if (NEVER_ENDS.has(word.toLowerCase().replace(/^\.+|\.+$/g, ''))) continue
      firstEnd = i + 1
    } else if (ch === '—' || ch === '–' || (ch === '-' && /\s/.test(text.charAt(i - 1)) && /\s/.test(text.charAt(i + 1)))) {
      firstEnd = i
    } else {
      continue
    }
    let secondStart = i + 1
    while (secondStart < range.end && /\s/.test(text.charAt(secondStart))) secondStart += 1
    while (firstEnd > range.start && /\s/.test(text.charAt(firstEnd - 1))) firstEnd -= 1
    const first = { start: range.start, end: firstEnd }
    const second = { start: secondStart, end: range.end }
    if (spokenText(text, mask, first).length < MIN_CLAUSE_CHARS || spokenText(text, mask, second).length < MIN_CLAUSE_CHARS) continue
    const distance = Math.abs(before - heard / 2)
    if (!best || distance < best.distance) best = { first, second, distance }
  }
  return best ? [best.first, best.second] : [range]
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
  // markdown syntax is never spoken: a word's weight counts only the characters that are
  const spoken = spokenMask(text)
  const words: Array<TextRange & { weight: number; endsSentence: boolean }> = []
  for (const match of text.slice(range.start, range.end).matchAll(/\S+/g)) {
    const token = match[0]
    const start = range.start + match.index
    let said = ''
    for (let i = 0; i < token.length; i++) if (spoken[start + i]) said += token.charAt(i)
    if (said === '') continue
    const letters = said.match(/[\p{L}\p{N}]/gu)?.length ?? 0
    const endsSentence = /[.!?…]["'”’»)\]]*$/.test(said)
    const pause = /[,;:]["'”’)\]]*$/.test(said)
      ? PAUSE_WEIGHT.weak
      : endsSentence ? PAUSE_WEIGHT.strong : 0
    const previous = words.at(-1)
    if (letters === 0) {
      // a dash or a stray mark has no sound of its own, only a short pause after the word before it
      if (previous) previous.weight += PAUSE_WEIGHT.weak
      continue
    }
    words.push({ start, end: start + token.length, weight: letters + pause, endsSentence })
  }
  const last = words.at(-1)
  if (last) last.weight -= last.endsSentence ? PAUSE_WEIGHT.strong : 0

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
