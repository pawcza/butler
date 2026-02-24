import RSSParser from 'rss-parser'

const parser = new RSSParser()

const FEEDS = [
  { label: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { label: 'BBC Tech', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { label: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
]

const ITEMS_PER_FEED = 5
const FETCH_TIMEOUT_MS = 8_000

async function fetchFeed(url: string, label: string): Promise<string | null> {
  try {
    const feed = await Promise.race([
      parser.parseURL(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ])

    const items = feed.items.slice(0, ITEMS_PER_FEED)
    if (items.length === 0) return null

    const lines = items.map((item) => {
      const title = item.title?.trim() ?? 'Untitled'
      const snippet = item.contentSnippet?.trim() ?? item.content?.trim() ?? ''
      return snippet ? `- ${title} — ${snippet.slice(0, 200)}` : `- ${title}`
    })

    return `[${label}]\n${lines.join('\n')}`
  } catch (err) {
    console.warn(`[news] failed to fetch ${label}: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

export async function fetchNewsBriefing(): Promise<string> {
  const results = await Promise.all(FEEDS.map((f) => fetchFeed(f.url, f.label)))
  const sections = results.filter((r): r is string => r !== null)

  if (sections.length === 0) {
    return 'All news feeds are currently unreachable. The outside world may have ended. Or not. Either way, you should probably stay inside.'
  }

  return sections.join('\n\n')
}
