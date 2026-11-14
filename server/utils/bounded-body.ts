/**
 * Reads `stream` into one buffer, giving up as soon as more than `limit` bytes have come in: the
 * rest is never read, and at most one chunk past the limit is ever held. Resolves to null when the
 * limit was passed.
 */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) return null
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}
