import { describe, expect, it } from 'vitest'
import { estimateWordTimings, spokenMask, spokenText, splitFirstSentence, splitSentences, wordIndexAt } from '../shared/speech'
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

/** What the engine would read for the whole text. */
const said = (text: string): string => spokenText(text, spokenMask(text), { start: 0, end: text.length })

describe('spokenText', () => {
  it('drops emphasis marks and backticks', () => {
    expect(said('This is **bold**, _italic_, *also italic*, __strong__, ~~gone~~ and `code`.')).toBe('This is bold, italic, also italic, strong, gone and code.')
    expect(said('***both*** at once')).toBe('both at once')
  })

  it('reads a link as its label, the url never', () => {
    expect(said('See [the docs](https://example.com/a_b_c?x=1) for more.')).toBe('See the docs for more.')
    expect(said('A picture: ![the lamp](http://x.test/l.png).')).toBe('A picture: the lamp.')
    expect(said('[**Bold** link](https://x.test) and _after_')).toBe('Bold link and after')
  })

  it('drops heading, bullet, number and quote markers at the start of a line', () => {
    expect(said('## The plan')).toBe('The plan')
    expect(said('- first item')).toBe('first item')
    expect(said('* second item')).toBe('second item')
    expect(said('3. third item')).toBe('third item')
    expect(said('2) next item')).toBe('next item')
    expect(said('> quoted words')).toBe('quoted words')
    expect(said('---')).toBe('')
    expect(said('```ts')).toBe('')
  })

  it('leaves plain text with look-alike characters alone', () => {
    expect(said('Use snake_case_names and 2 * 3 * 4 = 24, not a*b*c.')).toBe('Use snake_case_names and 2 * 3 * 4 = 24, not a*b*c.')
    expect(said('The score was 3-2 in the 5. round, a - b.')).toBe('The score was 3-2 in the 5. round, a - b.')
    expect(said('Zaczynamy 3. maja o dziesiątej.')).toBe('Zaczynamy 3. maja o dziesiątej.')
    expect(said('3. maja jest piątek.')).toBe('3. maja jest piątek.')
    expect(said('Dziękuję, zgaś światło.')).toBe('Dziękuję, zgaś światło.')
  })

  it('works on a range, with the mask taken from the whole block', () => {
    const text = 'First **one** sentence here. Then [two words](https://x.test) there.'
    const mask = spokenMask(text)
    const second = splitSentences(text)[1]
    expect(second && spokenText(text, mask, second)).toBe('Then two words there.')
  })
})

describe('estimateWordTimings with markdown', () => {
  it('times the spoken words only: a long url adds no time, and the ranges still point at the displayed words', () => {
    const plain = 'See the docs now please.'
    const marked = 'See [the docs](https://example.com/a/very/long/path/to/a/page) now **please**.'
    const range = { start: 0, end: marked.length }
    const timings = estimateWordTimings(marked, range, 4)
    const reference = estimateWordTimings(plain, { start: 0, end: plain.length }, 4)
    expect(timings).toHaveLength(reference.length)
    timings.forEach((t, i) => {
      expect(t.from).toBeCloseTo(reference[i]?.from ?? -1)
      expect(t.to).toBeCloseTo(reference[i]?.to ?? -1)
    })
    // a word's range is its displayed token, markup included
    expect(timings.map((t) => marked.slice(t.start, t.end))).toEqual(['See', '[the', 'docs](https://example.com/a/very/long/path/to/a/page)', 'now', '**please**.'])
    expect(timings.at(-1)?.to).toBeCloseTo(4)
  })

  it('has no word for a token that is only markup, and keeps the pause of a comma inside emphasis', () => {
    const text = '- **first,** second'
    const timings = estimateWordTimings(text, { start: 0, end: text.length }, 3)
    expect(timings.map((t) => text.slice(t.start, t.end))).toEqual(['**first,**', 'second'])
    const [first, second] = timings
    expect((first?.to ?? 0) - (first?.from ?? 0)).toBeGreaterThan((second?.to ?? 0) - (second?.from ?? 0) - 0.01 - 0.4)
  })
})

describe('splitFirstSentence', () => {
  const parts = (text: string): string[] => {
    const range = splitSentences(text)[0] ?? { start: 0, end: text.length }
    return splitFirstSentence(text, range).map((r) => text.slice(r.start, r.end))
  }

  it('leaves a sentence under 90 characters whole', () => {
    expect(parts('This one is short enough, so it is read in a single clip as it is.')).toHaveLength(1)
  })

  it('splits a long English sentence at the comma nearest the middle', () => {
    expect(parts('The living room lights are on, the heating is set to twenty degrees, and the front door has been locked since ten.')).toEqual([
      'The living room lights are on, the heating is set to twenty degrees,',
      'and the front door has been locked since ten.',
    ])
  })

  it('splits a long Polish sentence, at a semicolon or a colon', () => {
    expect(parts('Światło w salonie jest włączone i ogrzewanie działa normalnie; drzwi wejściowe zostały zamknięte dziś wieczorem o dziesiątej.')).toEqual([
      'Światło w salonie jest włączone i ogrzewanie działa normalnie;',
      'drzwi wejściowe zostały zamknięte dziś wieczorem o dziesiątej.',
    ])
    expect(parts('Mam dla ciebie trzy wiadomości na dzisiejszy wieczór: pierwsza dotyczy pogody, druga kalendarza, a trzecia poczty.')[0]).toBe('Mam dla ciebie trzy wiadomości na dzisiejszy wieczór:')
  })

  it('splits at a dash, which is not read', () => {
    expect(parts('The kitchen window has been open for more than an hour now — you may want to close it before it gets cold.')).toEqual([
      'The kitchen window has been open for more than an hour now',
      'you may want to close it before it gets cold.',
    ])
  })

  it('never splits inside a number, a time, an abbreviation or a parenthesis', () => {
    const number = 'The total came to 1,250,000 euros over the whole of the year and the figures were checked by two other people.'
    expect(parts(number)).toEqual([number])
    const time = 'The meeting starts at 10:30 sharp in the large conference room on the second floor of the main building.'
    expect(parts(time)).toEqual([time])
    const abbreviation = 'Please ring the office tomorrow, e.g. before the first meeting of the day starts at nine in the morning sharp.'
    expect(parts(abbreviation).join(' ')).toBe(abbreviation)
    expect(parts(abbreviation)[0]).not.toMatch(/e\.g\.$/)
    const parenthesis = 'The report (which is long, boring, and full of numbers that nobody ever really reads) arrived this morning by mail.'
    expect(parts(parenthesis)).toEqual([parenthesis])
    expect(parts('Spotkanie jest w piątek, np. u pana Kowalskiego w biurze na drugim piętrze budynku przy głównej ulicy w centrum.')[0]).toBe('Spotkanie jest w piątek, np. u pana Kowalskiego w biurze na drugim piętrze budynku przy głównej ulicy w centrum.')
  })

  it('never makes a fragment under 25 characters', () => {
    const early = 'Well, the answer to this question depends on a great many things that we have not yet had a chance to discuss at all.'
    expect(parts(early)).toEqual([early])
    const late = 'The answer to this question depends on a great many things that we have not yet had a chance to discuss, no.'
    expect(parts(late)).toEqual([late])
  })

  it('finds the middle of the spoken words, and keeps the pieces as ranges of the displayed text', () => {
    // a long url after the second comma would drag the middle of the raw text towards it
    const text = `**The living room lights** are on, the heating is set to twenty degrees, and [the door](https://example.com/${'long/'.repeat(30)}) is locked.`
    const [range] = splitSentences(text)
    const pieces = range ? splitFirstSentence(text, range) : []
    expect(pieces).toHaveLength(2)
    expect(pieces[0]?.start).toBe(0)
    expect(text.slice(pieces[0]?.start, pieces[0]?.end)).toBe('**The living room lights** are on,')
    expect(text.slice(pieces[1]?.start, pieces[1]?.end)).toMatch(/^the heating is set to twenty degrees, and \[the door\]\(.*\) is locked\.$/)
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
