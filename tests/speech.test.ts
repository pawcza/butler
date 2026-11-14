import { describe, expect, it } from 'vitest'
import { estimateWordTimings, splitSentences, wordIndexAt } from '../shared/speech'
import { renderInlineMarkdown } from '../shared/text'

/** The sentences as text, so the cases read naturally. */
const sentences = (text: string): string[] => splitSentences(text).map((r) => text.slice(r.start, r.end))

describe('splitSentences', () => {
  it('splits on . ! ? and …, keeping the punctuation', () => {
    expect(sentences('It is quiet in the house tonight. Is anyone at home right now? I certainly hope so! Well… we shall see in the morning.')).toEqual([
      'It is quiet in the house tonight.',
      'Is anyone at home right now?',
      'I certainly hope so!',
      'Well… we shall see in the morning.',
    ])
  })

  it('returns character ranges into the original text, without the whitespace between', () => {
    const text = '  The lamp in the hall is on.   The front door is locked.  '
    const ranges = splitSentences(text)
    expect(ranges).toEqual([{ start: 2, end: 29 }, { start: 32, end: 57 }])
    expect(text.slice(2, 29)).toBe('The lamp in the hall is on.')
  })

  it('does not split inside decimals, versions or times', () => {
    expect(sentences('The price went from 3.5 to 4.25 euros overall. Version 2.1.3 is out now.')).toEqual([
      'The price went from 3.5 to 4.25 euros overall.',
      'Version 2.1.3 is out now.',
    ])
  })

  it('does not split after English titles and abbreviations', () => {
    expect(sentences('Dr. Smith will see you at noon. Mrs. Jones called, e.g. about the invoice. Please ring her back later.')).toEqual([
      'Dr. Smith will see you at noon.',
      'Mrs. Jones called, e.g. about the invoice.',
      'Please ring her back later.',
    ])
  })

  it('does not split before a lowercase continuation or after an initial', () => {
    expect(sentences('Ask J. Smith about it tomorrow morning. Approx. five minutes are left in total.')).toEqual([
      'Ask J. Smith about it tomorrow morning.',
      'Approx. five minutes are left in total.',
    ])
  })

  it('handles Polish abbreviations, ordinals and dates', () => {
    expect(sentences('Spotkanie jest w piątek, np. u pana Kowalskiego. Zaczynamy 3. maja o godz. 10 rano. Zapraszam wszystkich!')).toEqual([
      'Spotkanie jest w piątek, np. u pana Kowalskiego.',
      'Zaczynamy 3. maja o godz. 10 rano.',
      'Zapraszam wszystkich!',
    ])
  })

  it('splits after etc. and itd. when a new sentence follows', () => {
    expect(sentences('Mam chleb, masło, ser itd. Potem pójdę do sklepu po resztę.')).toEqual([
      'Mam chleb, masło, ser itd.',
      'Potem pójdę do sklepu po resztę.',
    ])
  })

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(sentences('He said "stop right there." Then he left (quietly). Nobody followed him.')).toEqual([
      'He said "stop right there."',
      'Then he left (quietly).',
      'Nobody followed him.',
    ])
  })

  it('joins very short fragments with a neighbour', () => {
    expect(sentences('Yes. I can do that for you right now.')).toEqual(['Yes. I can do that for you right now.'])
    expect(sentences('Hello! How are you doing today? Fine.')).toEqual(['Hello! How are you doing today? Fine.'])
    expect(sentences('Tak. Zaraz to zrobię dla ciebie od ręki. Dobrze.')).toEqual([
      'Tak. Zaraz to zrobię dla ciebie od ręki. Dobrze.',
    ])
  })

  it('folds a short last fragment into the sentence before it', () => {
    expect(sentences('The report is finished and sent to you. Done.')).toEqual(['The report is finished and sent to you. Done.'])
  })

  it('speaks text with no terminator as one sentence, and nothing for blank text', () => {
    expect(sentences('no punctuation here at all')).toEqual(['no punctuation here at all'])
    expect(splitSentences('   ')).toEqual([])
    expect(splitSentences('')).toEqual([])
  })
})

describe('estimateWordTimings', () => {
  const text = 'Good evening, sir. Everything is running smoothly.'
  const range = { start: 0, end: text.length }

  it('covers the clip: contiguous words from 0 to the duration', () => {
    const timings = estimateWordTimings(text, range, 6)
    expect(timings.map((t) => text.slice(t.start, t.end))).toEqual(['Good', 'evening,', 'sir.', 'Everything', 'is', 'running', 'smoothly.'])
    expect(timings[0]?.from).toBe(0)
    expect(timings.at(-1)?.to).toBeCloseTo(6)
    for (let i = 1; i < timings.length; i++) expect(timings[i]?.from).toBeCloseTo(timings[i - 1]?.to ?? -1)
  })

  it('gives longer words more time', () => {
    const [good, , , everything, is] = estimateWordTimings(text, range, 6)
    const span = (t?: { from: number; to: number }) => (t ? t.to - t.from : 0)
    expect(span(everything)).toBeGreaterThan(span(good))
    expect(span(good)).toBeGreaterThan(span(is))
  })

  it('adds a pause after punctuation, longer at a sentence end than at a comma', () => {
    const same = estimateWordTimings('aaaa, aaaa aaaa. aaaa aaaa', { start: 0, end: 26 }, 10)
    const span = (i: number) => (same[i] ? same[i].to - same[i].from : 0)
    // word 0 ends with a comma, word 1 has none, word 2 ends a sentence
    expect(span(0)).toBeGreaterThan(span(1))
    expect(span(2)).toBeGreaterThan(span(0))
  })

  it('has no pause at the very end of the clip', () => {
    const [a, b] = estimateWordTimings('same same.', { start: 0, end: 10 }, 2)
    expect((a?.to ?? 0) - (a?.from ?? 0)).toBeCloseTo((b?.to ?? 0) - (b?.from ?? 0))
  })

  it('times only the words inside the range, with offsets into the whole text', () => {
    const second = { start: text.indexOf('Everything'), end: text.length }
    const timings = estimateWordTimings(text, second, 3)
    expect(timings[0]?.start).toBe(second.start)
    expect(timings.at(-1)?.end).toBe(text.length)
    expect(timings.at(-1)?.to).toBeCloseTo(3)
  })

  it('folds a lone dash into the pause of the word before it', () => {
    const timings = estimateWordTimings('wait — stop', { start: 0, end: 11 }, 3)
    expect(timings.map((t) => 'wait — stop'.slice(t.start, t.end))).toEqual(['wait', 'stop'])
  })

  it('returns nothing for a range without words', () => {
    expect(estimateWordTimings('   ', { start: 0, end: 3 }, 2)).toEqual([])
  })
})

describe('wordIndexAt', () => {
  const timings = estimateWordTimings('one two three four', { start: 0, end: 18 }, 4)

  it('finds the word being spoken at a time, and stays on the last one after the end', () => {
    expect(wordIndexAt(timings, 0)).toBe(0)
    expect(wordIndexAt(timings, 3.99)).toBe(3)
    expect(wordIndexAt(timings, 9)).toBe(3)
    const second = timings[1]
    expect(wordIndexAt(timings, ((second?.from ?? 0) + (second?.to ?? 0)) / 2)).toBe(1)
  })

  it('is -1 without words', () => {
    expect(wordIndexAt([], 1)).toBe(-1)
  })
})

describe('renderInlineMarkdown marks', () => {
  const mark = (text: string, word: string, className = 'now') => {
    const start = text.indexOf(word)
    return { start, end: start + word.length, className }
  }

  it('renders as before without marks', () => {
    expect(renderInlineMarkdown('**bold** & <b>')).toBe('<strong>bold</strong> &amp; &lt;b&gt;')
  })

  it('wraps a word in a span', () => {
    expect(renderInlineMarkdown('the lamp is on', [mark('the lamp is on', 'lamp')])).toBe('the <span class="now">lamp</span> is on')
  })

  it('keeps a mark inside the bold or italic it belongs to', () => {
    const bold = '**the lamp** is on'
    expect(renderInlineMarkdown(bold, [mark(bold, '**the'), mark(bold, 'lamp**')]))
      .toBe('<strong><span class="now">the</span> <span class="now">lamp</span></strong> is on')
    const italic = 'it is _very quiet_ now'
    expect(renderInlineMarkdown(italic, [mark(italic, 'quiet_', 'spoken')]))
      .toBe('it is <em>very <span class="spoken">quiet</span></em> now')
  })

  it('leaves a link intact and marks the words of its label', () => {
    const text = 'see [the docs](https://example.com/a) now'
    const html = renderInlineMarkdown(text, [mark(text, '[the'), mark(text, 'docs](https://example.com/a)')])
    expect(html).toBe('see <a href="https://example.com/a" rel="noopener noreferrer" target="_blank"><span class="now">the</span> <span class="now">docs</span></a> now')
  })

  it('escapes html around marks and ignores a mark with nothing left', () => {
    const text = 'a <b> & **'
    expect(renderInlineMarkdown(text, [mark(text, '<b>'), { start: 8, end: 10, className: 'now' }]))
      .toBe('a <span class="now">&lt;b&gt;</span> &amp; **')
  })

  it('marks several words with different classes', () => {
    const text = 'one two three'
    expect(renderInlineMarkdown(text, [mark(text, 'one', 'spoken'), mark(text, 'two', 'speaking')]))
      .toBe('<span class="spoken">one</span> <span class="speaking">two</span> three')
  })
})
