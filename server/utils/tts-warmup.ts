/**
 * Keeps a self-hosted speech engine loaded. `fire` runs one throwaway synthesis unless one finished
 * recently (`touch` records that) or the last throwaway is still running. A failure is swallowed:
 * a warm-up must never delay or fail a turn.
 */
export function createWarmup(options: {
  run: () => Promise<unknown>
  /** How long after a finished synthesis another one is pointless. */
  quietMs?: number
  now?: () => number
}) {
  const quietMs = options.quietMs ?? 30_000
  const now = options.now ?? Date.now
  let lastFinished = Number.NEGATIVE_INFINITY
  let running = false

  return {
    /** A synthesis finished: the engine is warm for a while. */
    touch(): void {
      lastFinished = now()
    },
    /** Starts a warm-up unless the engine is warm already. Returns whether it started one. */
    fire(): boolean {
      if (running || now() - lastFinished < quietMs) return false
      running = true
      void options.run().catch(() => {}).finally(() => { running = false })
      return true
    },
  }
}
