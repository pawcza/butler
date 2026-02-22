import type { ClientMessage, ServerEvent } from '~/shared/types'

const sessions = new Map<string, SessionManager>()

function send(peer: { send: (data: string) => void }, event: ServerEvent): void {
  peer.send(JSON.stringify(event))
}

export default defineWebSocketHandler({
  open(peer) {
    const session = new SessionManager((state) => {
      send(peer, { type: 'state', state })
    })
    sessions.set(peer.id, session)
    send(peer, { type: 'state', state: session.getState() })
  },

  async message(peer, msg) {
    const session = sessions.get(peer.id)
    if (!session) return

    const raw = msg.rawData

    // Binary frame = audio recording from the client
    if (raw instanceof ArrayBuffer || Buffer.isBuffer(raw)) {
      if (session.getState() !== 'IDLE') {
        send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
        return
      }

      const buffer = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(new Uint8Array(raw as ArrayBuffer))

      void processAudio(buffer, session, (event) => send(peer, event))
      return
    }

    // Text frame = control message
    console.log('[ws] text frame, rawData type:', typeof msg.rawData, 'isBuffer:', Buffer.isBuffer(msg.rawData), 'text:', msg.text())
    let parsed: ClientMessage | null = null
    try {
      parsed = JSON.parse(msg.text()) as ClientMessage
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
      console.log('[ws] text command:', JSON.stringify(parsed.text))
      processCommand(parsed.text, session, (event) => send(peer, event)).catch((err) => {
        console.error('[ws] processCommand threw:', err)
        send(peer, { type: 'error', message: err instanceof Error ? err.message : 'Internal error' })
        session.setState('IDLE')
      })
    }
  },

  close(peer) {
    sessions.get(peer.id)?.clearHistory()
    sessions.delete(peer.id)
  },

  error(peer, error) {
    console.error(`[ws] peer ${peer.id} error:`, error)
  },
})
