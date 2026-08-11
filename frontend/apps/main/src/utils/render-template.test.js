// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderTemplate } from '@shared-ui/utils/string.js'

describe('renderTemplate', () => {
  describe('variable replacement', () => {
    it('replaces {{.FirstName}}', () => {
      expect(renderTemplate('Hi {{.FirstName}}', { firstName: 'John' }))
        .toBe('Hi John')
    })

    it('replaces {{.LastName}}', () => {
      expect(renderTemplate('Hi {{.LastName}}', { lastName: 'Doe' }))
        .toBe('Hi Doe')
    })

    it('replaces both variables', () => {
      expect(renderTemplate('{{.FirstName}} {{.LastName}}', { firstName: 'John', lastName: 'Doe' }))
        .toBe('John Doe')
    })

    it('replaces missing key with empty string', () => {
      expect(renderTemplate('Hi {{.FirstName}}', { lastName: 'Doe' }))
        .toBe('Hi ')
    })

    it('is case insensitive for keys', () => {
      expect(renderTemplate('{{.firstname}} {{.FIRSTNAME}} {{.FirstName}}', { firstName: 'Jo' }))
        .toBe('Jo Jo Jo')
    })

    it('handles whitespace inside delimiters', () => {
      expect(renderTemplate('Hi {{ .FirstName }}', { firstName: 'John' }))
        .toBe('Hi John')
    })

    it('handles multiple occurrences of same variable', () => {
      expect(renderTemplate('{{.FirstName}} and {{.FirstName}}', { firstName: 'John' }))
        .toBe('John and John')
    })

    it('handles names with special characters', () => {
      expect(renderTemplate('Hi {{.FirstName}}', { firstName: "O'Brien" }))
        .toBe("Hi O'Brien")
    })

    it('handles names with spaces', () => {
      expect(renderTemplate('Hi {{.FirstName}}', { firstName: 'Mary Jane' }))
        .toBe('Hi Mary Jane')
    })

    it('works with any key names', () => {
      expect(renderTemplate('{{.Company}} - {{.City}}', { company: 'Acme', city: 'NYC' }))
        .toBe('Acme - NYC')
    })
  })

  describe('pipe fallback', () => {
    it('uses value when present', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}', { firstName: 'John' }))
        .toBe('Hi John')
    })

    it('uses fallback when value is empty', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}', { firstName: '' }))
        .toBe('Hi there')
    })

    it('uses fallback when key is missing', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}', {}))
        .toBe('Hi there')
    })

    it('uses fallback when data is empty object', () => {
      expect(renderTemplate('Hi {{.FirstName | friend}}', {}))
        .toBe('Hi friend')
    })

    it('handles fallback with spaces', () => {
      expect(renderTemplate('Hi {{.FirstName | valued customer}}', {}))
        .toBe('Hi valued customer')
    })

    it('handles whitespace around pipe', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}', {}))
        .toBe('Hi there')
    })

    it('handles multiple pipes in same text', () => {
      expect(renderTemplate(
        '{{.FirstName | friend}} {{.LastName | }}',
        { firstName: '', lastName: '' }
      )).toBe('friend ')
    })

    it('uses empty fallback when pipe has no value after it', () => {
      expect(renderTemplate('Hi{{.FirstName | }}!', {}))
        .toBe('Hi!')
    })

    it('picks value over fallback', () => {
      expect(renderTemplate('{{.FirstName | fallback}}', { firstName: 'Real' }))
        .toBe('Real')
    })
  })

  describe('real-world greeting patterns', () => {
    it('Hi FirstName with fallback to there', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}!', { firstName: 'Abhinav' }))
        .toBe('Hi Abhinav!')
      expect(renderTemplate('Hi {{.FirstName | there}}!', {}))
        .toBe('Hi there!')
    })

    it('greeting with period', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}.', { firstName: 'Abhinav' }))
        .toBe('Hi Abhinav.')
      expect(renderTemplate('Hi {{.FirstName | there}}.', {}))
        .toBe('Hi there.')
    })

    it('greeting with comma and continuation', () => {
      expect(renderTemplate('Hey {{.FirstName | there}}, how can we help?', { firstName: 'Abhinav' }))
        .toBe('Hey Abhinav, how can we help?')
    })

    it('simple variable-only greeting', () => {
      expect(renderTemplate('Hello {{.FirstName}}', { firstName: 'Abhinav' }))
        .toBe('Hello Abhinav')
    })

    it('full name with fallback', () => {
      expect(renderTemplate('Welcome {{.FirstName | back}}!', { firstName: 'John' }))
        .toBe('Welcome John!')
      expect(renderTemplate('Welcome {{.FirstName | back}}!', {}))
        .toBe('Welcome back!')
    })

    it('plain text with no variables', () => {
      expect(renderTemplate('How can we help?', {}))
        .toBe('How can we help?')
    })

    it('just a variable', () => {
      expect(renderTemplate('{{.FirstName}}', { firstName: 'John' }))
        .toBe('John')
    })

    it('mixed variables and fallbacks', () => {
      expect(renderTemplate(
        'Hi {{.FirstName | there}}, your account ({{.Email | no email}}) is active.',
        { firstName: 'John', email: 'john@test.com' }
      )).toBe('Hi John, your account (john@test.com) is active.')
    })
  })

  describe('edge cases', () => {
    it('returns null as-is', () => {
      expect(renderTemplate(null, {})).toBe(null)
    })

    it('returns undefined as-is', () => {
      expect(renderTemplate(undefined, {})).toBe(undefined)
    })

    it('returns empty string as-is', () => {
      expect(renderTemplate('', {})).toBe('')
    })

    it('returns text as-is when data is null', () => {
      expect(renderTemplate('Hi {{.FirstName | there}}', null))
        .toBe('Hi {{.FirstName | there}}')
    })

    it('returns text as-is when data is undefined', () => {
      expect(renderTemplate('Hi {{.FirstName}}', undefined))
        .toBe('Hi {{.FirstName}}')
    })

    it('returns plain text unchanged', () => {
      expect(renderTemplate('Hello world', { firstName: 'John' }))
        .toBe('Hello world')
    })

    it('single braces are not template syntax', () => {
      expect(renderTemplate('Use {name} here', { name: 'John' }))
        .toBe('Use {name} here')
    })

    it('handles adjacent punctuation', () => {
      expect(renderTemplate('({{.FirstName}})', { firstName: 'John' }))
        .toBe('(John)')
    })

    it('handles pipe char in regular text', () => {
      expect(renderTemplate('A | B', { firstName: 'John' }))
        .toBe('A | B')
    })
  })
})
