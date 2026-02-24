import type { ClientMessage, ServerEvent } from '~/shared/types'

const sessions = new Map<string, SessionManager>()

function send(peer: { send: (data: string) => void }, event: ServerEvent): void {
  peer.send(JSON.stringify(event))
}

export default defineWebSocketHandler({
  open(peer) {
    console.log('[ws] peer opened:', peer.id)
    const session = new SessionManager((state) => {
      send(peer, { type: 'state', state })
    })
    sessions.set(peer.id, session)
    send(peer, { type: 'state', state: session.getState() })
  },

  async message(peer, msg) {
    console.log('[ws] message handler, peer:', peer.id, '| sessions size:', sessions.size, '| rawData type:', typeof msg.rawData, '| isBuffer:', Buffer.isBuffer(msg.rawData))
    const session = sessions.get(peer.id)
    if (!session) {
      console.log('[ws] no session for peer:', peer.id)
      return
    }

    const raw = msg.rawData
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : raw instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(raw))
        : Buffer.from(String(raw), 'utf-8')

    // Crossws delivers all frames as Buffers. Distinguish by first byte:
    // JSON messages start with '{' (0x7b); audio is WebM (0x1a) or WAV ('R' = 0x52).
    if (buffer[0] === 0x7b) {
      // Text / control message
      let parsed: ClientMessage | null = null
      try {
        parsed = JSON.parse(buffer.toString('utf-8')) as ClientMessage
      } catch {
        return
      }

      if (parsed.type === 'ping') {
        send(peer, { type: 'pong' })
      } else if (parsed.type === 'clear_history') {
        session.clearHistory()
      } else if (parsed.type === 'command') {
        if (session.getState() !== 'IDLE') {
          send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
          return
        }
        send(peer, { type: 'transcript', text: parsed.text })
        console.log('[ws] text command:', JSON.stringify(parsed.text))
        processCommand(parsed.text, session, (event) => send(peer, event), peer.id).catch((err) => {
          console.error('[ws] processCommand threw:', err)
          send(peer, { type: 'error', message: err instanceof Error ? err.message : 'Internal error' })
          session.setState('IDLE')
        })
      }
    } else {
      // Binary audio frame
      if (session.getState() !== 'IDLE') {
        send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
        return
      }
      void processAudio(buffer, session, (event) => send(peer, event), peer.id)
    }
  },

  close(peer) {
    sessions.get(peer.id)?.clearHistory()
    sessions.delete(peer.id)
    clearTimersForPeer(peer.id)
  },

  error(peer, error) {
    console.error(`[ws] peer ${peer.id} error:`, error)
  },
})
