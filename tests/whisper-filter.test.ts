import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it } from 'vitest'

let isWhisperHallucination: (text: string) => boolean

beforeAll(async () => {
  process.env['DATA_DIR'] = tmpdir()
  ;({ isWhisperHallucination } = await import('../server/utils/pipeline'))
})

describe('isWhisperHallucination', () => {
  it('drops the English phrases whisper makes up from silence', () => {
    for (const text of ['Thank you.', 'Thanks for watching!', 'Subtitles by the Amara.org community', '[Music]', 'you', 'Bye.']) {
      expect(isWhisperHallucination(text), text).toBe(true)
    }
  })

  it('drops the common Polish ones', () => {
    for (const text of [
      'Dziękuję za oglądanie.',
      'Dziękuję za uwagę',
      'Dziękuję bardzo za uwagę!',
      'Dziękujemy za oglądanie.',
      'Dziękuję wszystkim za obejrzenie',
      'Napisy stworzone przez społeczność Amara.org',
      'Napisy: Jan Kowalski',
      'Napisy wykonane przez Jana Kowalskiego',
      'Tłumaczenie i napisy: Anna Nowak',
      'Zapraszam do subskrypcji.',
      'Zapraszam do subskrypcji kanału',
      'Do zobaczenia w następnym odcinku.',
      'Do zobaczenia w następnym odcinku!',
      'Do zobaczenia.',
      'Zasubskrybuj kanał i zostaw łapkę w górę',
      'Muzyka',
      '(muzyka)',
    ]) {
      expect(isWhisperHallucination(text), text).toBe(true)
    }
  })

  it('keeps real short Polish commands', () => {
    for (const text of [
      'Dziękuję, zgaś światło',
      'Dziękuję, włącz muzykę w salonie.',
      'Dziękuję za informację, a teraz zgaś światło',
      'Zgaś światło w kuchni',
      'Włącz napisy',
      'Napisy po polsku proszę',
      'Zapraszam gości na siódmą, ustaw przypomnienie',
      'Do zobaczenia jutro, wyłącz telewizor',
      'Włącz muzykę',
      'Zasubskrybuj mi kalendarz kolegi',
      'Ustaw budzik na szóstą',
    ]) {
      expect(isWhisperHallucination(text), text).toBe(false)
    }
  })
})
