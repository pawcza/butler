/** Pure, isomorphic text helpers shared between server and client. */

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

/**
 * Escape HTML, then render the common inline markdown the LLM emits: bold, italic, inline code, links.
 * Block-level markdown (lists, headings, code blocks) is intentionally out of scope — our assistant text is short.
 * Links only match http(s) URLs so `javascript:` / `data:` schemes can't sneak through.
 */
export function renderInlineMarkdown(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(/\*\*([^\n*][^\n]*?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^\n_][^\n]*?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*(?!\s)([^\n*]+?)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_])_(?!\s)([^\n_]+?)_(?!_)/g, '$1<em>$2</em>')
  s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>')
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
  )
  return s
}
