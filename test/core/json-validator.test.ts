import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JsonValidator } from '../../src/core/json-validator.js'

let tmpFile: string

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `json-validator-${process.pid}-${Date.now()}.json`)
})

afterEach(async () => {
  await rm(tmpFile, { force: true })
})

describe('JsonValidator', () => {
  test('validates object and file inputs and stores the last valid value', async () => {
    const validator = new JsonValidator<{ name: string }>({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' }
      },
      additionalProperties: false
    }, 'test schema')

    expect(validator.validate({ name: 'world' })).toEqual({ name: 'world' })
    expect(validator.value).toEqual({ name: 'world' })

    await writeFile(tmpFile, JSON.stringify({ name: 'file' }))

    expect(validator.validate(tmpFile)).toEqual({ name: 'file' })
  })

  test('formats validation, parse and load errors', async () => {
    const validator = new JsonValidator<{ name: string }>({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' }
      },
      additionalProperties: false
    }, 'test schema')

    expect(() => validator.validate({ name: 'world', extra: true }))
      .toThrow('/ must NOT have additional properties: extra')
    expect(() => validator.validate({}))
      .toThrow('/ must have required property')

    await writeFile(tmpFile, '{')
    expect(() => validator.validate(tmpFile))
      .toThrow('[CONFIG]: ERROR unable to parse')

    expect(() => validator.validate('missing-json-validator-file.json'))
      .toThrow('[CONFIG]: unable to load json missing-json-validator-file.json')
  })
})
