import type { ClientMessage, ServerEvent } from '~/shared/types'
import { FrameBudget, MAX_JSON_FRAME_BYTES, decodeAudioFrame } from '~/shared/audio'

const log = createLog('ws')
const sessions = new Map<string, SessionManager>()
/** The open microphone capture per peer, between `audio_start` and `audio_end`. */
const captures = new Map<string, Capture>()
/** What size of frame each open capture may still receive. */
const budgets = new Map<string, FrameBudget>()

function send(peer: { send: (data: string) => void }, event: ServerEvent): void {
  peer.send(JSON.stringify(event))
}

/** Close a peer's capture and answer it. */
function endCapture(peerId: string, session: SessionManager, emit: (event: ServerEvent) => void): void {
  const capture = captures.get(peerId)
  if (!capture) return
  captures.delete(peerId)
  budgets.delete(peerId)
  processCapture(capture, session, emit).catch((err) => {
    log.fail('processCapture threw:', err)
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Internal error' })
    session.setState('IDLE')
  })
}

/** Drop a peer's capture. Returns its id, or null when none was open. */
function dropCapture(peerId: string): string | null {
  const capture = captures.get(peerId)
  if (!capture) return null
  captures.delete(peerId)
  budgets.delete(peerId)
  capture.live.cancel()
  return capture.id
}

export default defineWebSocketHandler({
  // Server middleware never sees an upgrade, so the session is checked here, before the socket opens.
  upgrade(request) {
    if (!oidc) return
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== oidc.origin) {
      log.warn('rejected upgrade from origin:', origin)
      return new Response('Forbidden', { status: 403 })
    }
    if (!sessionFromCookieHeader(request.headers.get('cookie'), oidc.sessionSecret)) {
      log.warn('rejected upgrade without a session')
      return new Response('Unauthorized', { status: 401 })
    }
  },

  open(peer) {
    log.info('peer opened:', peer.id)
    // The upgrade guard already let this socket in, so the cookie is valid: read who it is for.
    const user = oidc ? sessionFromCookieHeader(peer.request.headers.get('cookie'), oidc.sessionSecret) : null
    const session = new SessionManager((state) => {
      send(peer, { type: 'state', state })
    }, user?.sub)
    sessions.set(peer.id, session)
    send(peer, { type: 'state', state: session.getState() })
  },

  async message(peer, msg) {
    const session = sessions.get(peer.id)
    if (!session) {
      log.warn('no session for peer:', peer.id)
      return
    }

    const raw = msg.rawData
    // an ArrayBuffer is viewed, not copied: a frame that is too big is dropped before any copy
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : Buffer.from(String(raw), 'utf-8')

    const emit = (event: ServerEvent) => send(peer, event)
    // The Node adapter hands over text and binary frames alike as Buffers, without saying which.
    // JSON messages start with '{' (0x7b); audio frames start with AUDIO_FRAME_TAG.
    if (buffer[0] === 0x7b) {
      // The platform has read the whole frame already (the socket library's limit is not ours to set
      // here), but nothing is decoded or parsed past this point for one that is too big.
      if (buffer.length > MAX_JSON_FRAME_BYTES) {
        log.warn(`dropped an oversized text frame (${buffer.length} bytes)`)
        return
      }
      // Text / control message
      let parsed: ClientMessage | null = null
      try {
        parsed = JSON.parse(buffer.toString('utf-8')) as ClientMessage
      } catch {
        return
      }

      // a capture in progress counts as busy too, so a typed command can't overlap it
      const busy = session.getState() !== 'IDLE' || captures.has(peer.id)

      if (parsed.type === 'stop_speech') {
        session.stopSpeech()
        log.info('speech stopped by the client')
      } else if (parsed.type === 'set_conversation') {
        if (busy) {
          send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
          return
        }
        session.setConversationId(typeof parsed.id === 'string' && parsed.id ? parsed.id : null)
        log.info(`conversation: ${session.getConversationId() ?? 'new'}`)
      } else if (parsed.type === 'command') {
        if (busy) {
          send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
          return
        }
        warmUpSpeech()
        send(peer, { type: 'transcript', id: newTranscriptId(), text: parsed.text })
        log.info('text command:', JSON.stringify(parsed.text))
        processCommand(parsed.text, session, (event) => send(peer, event)).catch((err) => {
          log.fail('processCommand threw:', err)
          send(peer, { type: 'error', message: err instanceof Error ? err.message : 'Internal error' })
          session.setState('IDLE')
        })
      } else if (parsed.type === 'audio_start') {
        if (!session.canCapture()) {
          send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
          send(peer, { type: 'capture_refused' })
          return
        }
        // barge-in: the user talks over the speech, or over a reply still being written (that turn is aborted)
        if (session.getState() !== 'IDLE') session.supersedeTurn()
        warmUpSpeech()
        // a capture the client left open is replaced, never merged
        const stale = dropCapture(peer.id)
        if (stale !== null) send(peer, { type: 'transcript_discarded', id: stale })
        budgets.set(peer.id, new FrameBudget())
        captures.set(peer.id, openCapture(emit, () => {
          log.warn('capture reached its length limit, answering it')
          endCapture(peer.id, session, emit)
        }))
      } else if (parsed.type === 'audio_end') {
        endCapture(peer.id, session, emit)
      } else if (parsed.type === 'audio_cancel') {
        const dropped = dropCapture(peer.id)
        if (dropped !== null) send(peer, { type: 'transcript_discarded', id: dropped })
      }
    } else {
      // frames that arrive after the capture closed (release, cap) are dropped
      const capture = captures.get(peer.id)
      if (!capture) return
      const verdict = budgets.get(peer.id)?.admit(buffer.length)
      if (verdict && verdict !== 'ok') {
        if (verdict === 'drop-first') log.warn(`dropped an oversized audio frame (${buffer.length} bytes); more of this capture are dropped silently`)
        return
      }
      const pcm = decodeAudioFrame(buffer)
      if (!pcm) {
        log.warn(`ignored an untagged binary frame (${buffer.length} bytes)`)
        return
      }
      capture.live.push(pcm)
    }
  },

  close(peer) {
    dropCapture(peer.id)
    sessions.get(peer.id)?.close()
    sessions.delete(peer.id)
  },

  error(peer, error) {
    log.fail(`peer ${peer.id} error:`, error)
  },
})
