import type { ServerEvent } from '~/shared/types'
import type { ExecutionResult } from './executor'

const EXECUTION_ACK_SYSTEM =
  `You are GLaDOS from Aperture Science. A home automation action was just executed on behalf of a test subject. ` +
  `Write exactly one short sentence reacting to the outcome, in character: cold, sardonic, passive-aggressive. ` +
  `Vary your phrasing every time. Do not list what was done. Just react.`

type Emitter = (event: ServerEvent) => void

async function generateExecutionAck(results: ExecutionResult[]): Promise<string> {
  const failed = results.filter((r) => !r.success)
  const successCount = results.length - failed.length

  let context: string
  if (failed.length === 0) {
    context = `Successfully executed: ${results.map((r) => `${r.tool} on ${r.entity_id}`).join(', ')}`
  } else if (successCount === 0) {
    context = `All actions failed: ${failed.map((r) => r.error ?? r.tool).join(', ')}`
  } else {
    context =
      `${successCount} of ${results.length} succeeded. ` +
      `Failed: ${failed.map((r) => `${r.tool} on ${r.entity_id}`).join(', ')}`
  }

  try {
    return await chat(context, [], EXECUTION_ACK_SYSTEM)
  } catch {
    return failed.length === 0 ? 'Procedure complete.' : 'Partial failure. How unsurprising.'
  }
}

async function speakAndEmit(text: string, session: SessionManager, emit: Emitter): Promise<void> {
  session.setState('SPEAKING')
  try {
    const audioBuffer = await synthesize(text)
    emit({ type: 'audio', data: audioBuffer.toString('base64'), format: config.PIPER_RESPONSE_FORMAT })
  } catch (err) {
    emit({ type: 'error', message: `TTS failed: ${err instanceof Error ? err.message : err}` })
  }
}

export async function processAudio(
  audioBuffer: Buffer,
  session: SessionManager,
  emit: Emitter,
): Promise<void> {
  session.setState('LISTENING')

  let transcript: string
  try {
    transcript = await transcribe(audioBuffer)
  } catch (err) {
    emit({ type: 'error', message: `STT failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }

  emit({ type: 'transcript', text: transcript })

  if (!transcript.trim()) {
    session.setState('IDLE')
    return
  }

  await processCommand(transcript, session, emit)
}

export async function processCommand(
  text: string,
  session: SessionManager,
  emit: Emitter,
): Promise<void> {
  session.setState('THINKING')

  const registry = getInteractableRegistry()
  const systemPrompt = buildSystemPrompt(registry)
  const history = session.getHistory()

  let rawResponse: string
  try {
    rawResponse = await chat(text, history, systemPrompt)
  } catch (err) {
    emit({ type: 'error', message: `LLM failed: ${err instanceof Error ? err.message : err}` })
    session.setState('IDLE')
    return
  }

  console.log(`[llm] raw response: ${rawResponse}`)

  session.addMessage({ role: 'user', content: text })
  session.addMessage({ role: 'assistant', content: rawResponse })

  const validated = validate(rawResponse)
  console.log(
    `[validator] type=${validated.type}`,
    validated.type === 'tool_calls' ? `calls=${JSON.stringify(validated.calls)}`
    : validated.type === 'conversation' ? `text="${validated.text}"`
    : `message="${validated.message}"`,
  )

  switch (validated.type) {
    case 'tool_calls': {
      session.setState('EXECUTING')
      const results = await execute(validated.calls)
      const replyText = await generateExecutionAck(results)
      emit({ type: 'response', text: replyText })
      await speakAndEmit(replyText, session, emit)
      break
    }
    case 'conversation': {
      emit({ type: 'response', text: validated.text })
      await speakAndEmit(validated.text, session, emit)
      break
    }
    case 'error': {
      const replyText = `A system anomaly has occurred. Cause: ${validated.message}. This is probably your fault.`
      emit({ type: 'error', message: validated.message })
      emit({ type: 'response', text: replyText })
      await speakAndEmit(replyText, session, emit)
      break
    }
  }

  session.setState('IDLE')
}
