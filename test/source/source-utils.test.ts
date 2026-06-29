import { open, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AbortSignalGuard, FileByteReader } from '../../src/source/source-utils.js'

let tmpFile: string

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `source-utils-${process.pid}-${Date.now()}.txt`)
  await writeFile(tmpFile, 'abcdef')
})

afterEach(async () => {
  await rm(tmpFile, { force: true })
})

describe('FileByteReader', () => {
  test('reads until the buffer is filled or EOF is reached', async () => {
    const handle = await open(tmpFile, 'r')

    try {
      const full = Buffer.alloc(3)
      await expect(FileByteReader.readFully(handle, full, 1)).resolves.toBe(3)
      expect(full.toString()).toBe('bcd')

      const partial = Buffer.alloc(4)
      await expect(FileByteReader.readFully(handle, partial, 4)).resolves.toBe(2)
      expect(partial.subarray(0, 2).toString()).toBe('ef')
    } finally {
      await handle.close()
    }
  })
})

describe('AbortSignalGuard', () => {
  test('throws explicit abort reasons or fallback errors', () => {
    expect(() => AbortSignalGuard.throwIfAborted(undefined, 'fallback')).not.toThrow()

    const explicit = new AbortController()
    explicit.abort('stop')
    expect(() => AbortSignalGuard.throwIfAborted(explicit.signal, 'fallback')).toThrow('stop')

    const fallback = new AbortController()
    fallback.abort()
    expect(AbortSignalGuard.reason(fallback.signal, 'fallback')).toBeInstanceOf(Error)
    expect(AbortSignalGuard.reason({ reason: undefined } as AbortSignal, 'fallback'))
      .toEqual(new Error('fallback'))
  })
})
