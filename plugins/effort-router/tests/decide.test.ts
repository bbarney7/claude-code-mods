import { expect, test } from 'claude-code/testing'
import { fromProbs, parseJev, parseLabel } from '../hooks/decide.ts'

test('a fair chance of hard raises; trivial must be likely to lower', () => {
  expect(fromProbs({ trivial: 0.07, standard: 0.56, hard: 0.37 })).toBe('standard')
  expect(fromProbs({ trivial: 0.1, standard: 0.45, hard: 0.45 })).toBe('hard')
  expect(fromProbs({ trivial: 0.75, standard: 0.2, hard: 0.05 })).toBe('trivial')
  // Probably trivial but not sure enough: too unsure to act on
  expect(fromProbs({ trivial: 0.6, standard: 0.3, hard: 0.1 })).toBeUndefined()
})

test('Jev and Haiku answers are read, and junk is not', () => {
  const jev =
    '{"model":"jev-1.13.0","answers":{"effort":{"type":"choice","choice":"standard","confidence":0.34,"probabilities":{"trivial":0.07,"standard":0.56,"hard":0.37}}}}'
  expect(parseJev(jev)).toEqual({ trivial: 0.07, standard: 0.56, hard: 0.37 })
  expect(parseJev('{"answers":{}}')).toBeUndefined()
  expect(parseJev('not json')).toBeUndefined()
  expect(parseLabel('Hard.')).toBe('hard')
  expect(parseLabel('no idea')).toBeUndefined()
})
