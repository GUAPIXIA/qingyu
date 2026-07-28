import { describe, it, expect } from 'vitest'
import { parseDialogue, type DialogueSegment } from '../dialogue-parser'

describe('parseDialogue', () => {
  describe('plain text / narration', () => {
    it('plain text without any dialogue/action markers returns a single plain segment', () => {
      const result = parseDialogue('Hello world')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('plain')
      expect(result[0].content).toBe('Hello world')
      expect(result[0].speaker).toBeUndefined()
    })

    it('plain Chinese text without markers returns a single plain segment', () => {
      const result = parseDialogue('今天天气不错')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('plain')
      expect(result[0].content).toBe('今天天气不错')
    })
  })

  describe('dialogue', () => {
    it('double-quoted "Hello" returns a dialogue segment', () => {
      const result = parseDialogue('"Hello"')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('dialogue')
      expect(result[0].content).toBe('Hello')
      expect(result[0].speaker).toBeUndefined()
    })

    it('curly-quoted \u201CHello\u201D returns a dialogue segment', () => {
      const result = parseDialogue('\u201CHello\u201D')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('dialogue')
      expect(result[0].content).toBe('Hello')
      expect(result[0].speaker).toBeUndefined()
    })

    it('Speaker: "text" returns dialogue with speaker (half-width colon)', () => {
      const result = parseDialogue('Alice: "Hello there"')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('dialogue')
      expect(result[0].speaker).toBe('Alice')
      expect(result[0].content).toBe('Hello there')
    })

    it('Speaker\uff1a "text" returns dialogue with speaker (full-width colon)', () => {
      const result = parseDialogue('Alice\uff1a "Hello there"')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('dialogue')
      expect(result[0].speaker).toBe('Alice')
      expect(result[0].content).toBe('Hello there')
    })

    it("Speaker: 'text' returns dialogue with speaker (single quotes)", () => {
      const result = parseDialogue("Bob: 'Hi there'")
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('dialogue')
      expect(result[0].speaker).toBe('Bob')
      expect(result[0].content).toBe('Hi there')
    })

    it('Chinese corner brackets \u300Ctext\u300D are normalized and return dialogue', () => {
      const result = parseDialogue('\u300C\u4F60\u597D\u300D')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('dialogue')
      expect(result[0].content).toBe('\u4F60\u597D')
    })
  })

  describe('action', () => {
    it('*does something* returns an action segment', () => {
      const result = parseDialogue('*does something*')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('action')
      expect(result[0].content).toBe('does something')
      expect(result[0].speaker).toBeUndefined()
    })

    it('*walks away* returns an action segment', () => {
      const result = parseDialogue('*walks away*')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('action')
      expect(result[0].content).toBe('walks away')
    })
  })

  describe('mixed content', () => {
    it('mixed content with dialogue, action, and narration returns multiple segments', () => {
      const result = parseDialogue('He said "hello" and *walked away*')
      expect(result.length).toBeGreaterThanOrEqual(3)

      const types = result.map((s) => s.type)
      expect(types).toContain('plain')
      expect(types).toContain('dialogue')
      expect(types).toContain('action')

      const dialogueSeg = result.find((s) => s.type === 'dialogue')
      expect(dialogueSeg?.content).toBe('hello')

      const actionSeg = result.find((s) => s.type === 'action')
      expect(actionSeg?.content).toBe('walked away')

      const plainSegs = result.filter((s) => s.type === 'plain')
      expect(plainSegs.length).toBeGreaterThanOrEqual(1)
    })

    it('preserves correct ordering of segments in mixed content', () => {
      const result = parseDialogue('He said "hello" and *walked away*')
      expect(result).toEqual([
        { type: 'plain', content: 'He said' },
        { type: 'dialogue', content: 'hello' },
        { type: 'plain', content: 'and' },
        { type: 'action', content: 'walked away' },
      ])
    })
  })

  describe('empty / edge cases', () => {
    it('empty string returns empty array', () => {
      const result = parseDialogue('')
      expect(result).toEqual([])
    })

    it('whitespace-only text with no markers returns a single plain segment', () => {
      // A plain space does not contain any marker characters, so it falls through
      // the precheck and returns a single plain segment (not trimmed by the precheck path).
      const result = parseDialogue('   ')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('plain')
    })
  })

  describe('markdown protection', () => {
    it('**bold** is protected and not parsed as an action', () => {
      const result = parseDialogue('**bold text**')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('plain')
      expect(result[0].content).toBe('**bold text**')
    })

    it('***bold italic*** is protected and not parsed as an action', () => {
      const result = parseDialogue('***bold italic***')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('plain')
      expect(result[0].content).toBe('***bold italic***')
    })

    it('inline code with quotes is protected', () => {
      const result = parseDialogue('Use `"quote"` for code')
      // The `"quote"` inside backticks is protected, so no dialogue segment
      const hasDialogue = result.some((s) => s.type === 'dialogue')
      expect(hasDialogue).toBe(false)
    })

    it("English contractions like don't are protected (not parsed as single-quote dialogue)", () => {
      const result = parseDialogue("I don't know")
      const hasDialogue = result.some((s) => s.type === 'dialogue')
      expect(hasDialogue).toBe(false)
    })

    it('HTML tags are protected (attributes with quotes not parsed as dialogue)', () => {
      const result = parseDialogue('<a href="http://example.com">link</a>')
      const hasDialogue = result.some((s) => s.type === 'dialogue')
      expect(hasDialogue).toBe(false)
    })
  })

  describe('multiple dialogue blocks', () => {
    it('multiple dialogue blocks are parsed correctly', () => {
      const result = parseDialogue('"Hello" she said. "How are you?"')
      expect(result.length).toBeGreaterThanOrEqual(3)

      const dialogueSegs = result.filter((s) => s.type === 'dialogue')
      expect(dialogueSegs).toHaveLength(2)
      expect(dialogueSegs[0].content).toBe('Hello')
      expect(dialogueSegs[1].content).toBe('How are you?')

      const plainSeg = result.find((s) => s.type === 'plain')
      expect(plainSeg?.content).toBe('she said.')
    })

    it('alternating speakers are parsed correctly', () => {
      const result = parseDialogue('Alice: "Hi" Bob: "Hey"')
      const dialogueSegs = result.filter((s) => s.type === 'dialogue')
      expect(dialogueSegs).toHaveLength(2)
      expect(dialogueSegs[0].speaker).toBe('Alice')
      expect(dialogueSegs[0].content).toBe('Hi')
      expect(dialogueSegs[1].speaker).toBe('Bob')
      expect(dialogueSegs[1].content).toBe('Hey')
    })
  })

  describe('return type', () => {
    it('returns an array of DialogueSegment objects', () => {
      const result = parseDialogue('test "dialogue" *action*')
      expect(Array.isArray(result)).toBe(true)
      for (const seg of result) {
        expect(['dialogue', 'action', 'plain']).toContain(seg.type)
        expect(typeof seg.content).toBe('string')
      }
    })
  })
})
