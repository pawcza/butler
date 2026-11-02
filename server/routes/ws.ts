import type { ClientMessage, ServerEvent } from '~/shared/types'

const log = createLog('ws')
const sessions = new Map<string, SessionManager>()

function send(peer: { send: (data: string) => void }, event: ServerEvent): void {
  peer.send(JSON.stringify(event))
}

export default defineWebSocketHandler({
  open(peer) {
    log.info('peer opened:', peer.id)
    const session = new SessionManager((state) => {
      send(peer, { type: 'state', state })
    })
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
      } else if (parsed.type === 'set_voice') {
        const validModel = typeof parsed.model === 'string' && parsed.model.length > 0 && parsed.model !== 'null'
        const validVoice = typeof parsed.voice === 'string' && parsed.voice.length > 0 && parsed.voice !== 'null'
        if (validModel && validVoice) {
          session.setTtsPreferences(parsed.model, parsed.voice)
          log.info(`voice set: model=${parsed.model} voice=${parsed.voice}`)
        } else {
          log.warn(`ignored invalid set_voice (model=${String(parsed.model)} voice=${String(parsed.voice)})`)
        }
      } else if (parsed.type === 'set_conversation') {
        if (session.getState() !== 'IDLE') {
          send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
          return
        }
        session.setConversationId(typeof parsed.id === 'string' && parsed.id ? parsed.id : null)
        log.info(`conversation: ${session.getConversationId() ?? 'new'}`)
      } else if (parsed.type === 'command') {
        if (session.getState() !== 'IDLE') {
          send(peer, { type: 'error', message: "I'm already busy. Wait until I'm done." })
          return
        }
        send(peer, { type: 'transcript', id: newTranscriptId(), text: parsed.text })
        log.info('text command:', JSON.stringify(parsed.text))
        processCommand(parsed.text, session, (event) => send(peer, event)).catch((err) => {
          log.fail('processCommand threw:', err)
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
      log.info(`audio received: ${(buffer.length / 1024).toFixed(1)}KB`)
      void processAudio(buffer, session, (event) => send(peer, event))
    }
  },

  close(peer) {
    sessions.get(peer.id)?.abortTurn()
    sessions.delete(peer.id)
  },

  error(peer, error) {
    log.fail(`peer ${peer.id} error:`, error)
  },
})
