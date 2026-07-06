/// <reference types="node" />

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    Registry,
    Singleton,
    assertExistsCreateDir,
    assertExistsDir,
    assertExistsFile,
    escape,
    isObject,
    isPlainObject,
    isTruthy,
    nonNegativeInteger,
    paramsFromUrl,
    parseArgs,
    parseNonNegativeInt,
    parsePixelIndex,
    parsePort,
    parsePositiveInt,
    stringify
} from '../../src/core/tools.js'
import { testTempPath } from '../test-temp.js'

const tempPath = testTempPath()

describe('tools', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.CONFIG
    })

    describe('parseArgs', () => {
        it('returns default options', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app'])

            expect(parseArgs()).toEqual({
                configPath: path.resolve(process.cwd(), 'config/config.json'),
                clearTileCache: false
            })
        })

        it('uses CONFIG environment variable as default config path', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app'])
            process.env.CONFIG = 'custom/config.json'

            expect(parseArgs().configPath).toBe(
                path.resolve(process.cwd(), 'custom/config.json')
            )
        })

        it('parses clear cache option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--clear-cache'])

            expect(parseArgs().clearTileCache).toBe(true)
        })

        it('parses clear cache short option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-cc'])

            expect(parseArgs().clearTileCache).toBe(true)
        })

        it('parses help option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--help'])
            expect(parseArgs().help).toBe(true)

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-h'])
            expect(parseArgs().help).toBe(true)
        })

        it('parses build index options', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--build-index-all'])
            expect(parseArgs().buildIndexAll).toBe(true)

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-bia'])
            expect(parseArgs().buildIndexAll).toBe(true)

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--build-index', 'world', '-bi', 'roads'])
            expect(parseArgs().buildIndexSources).toEqual(['world', 'roads'])

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--build-index-force'])
            expect(parseArgs().buildIndexForce).toBe(true)

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-bif'])
            expect(parseArgs().buildIndexForce).toBe(true)

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--cluster-workers', '2'])
            expect(parseArgs().clusterWorkers).toBe(2)

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-cw', '3'])
            expect(parseArgs().clusterWorkers).toBe(3)
        })

        it('rejects invalid build index options', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--build-index'])
            expect(() => parseArgs()).toThrow('--build-index requires a source id')

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-bi'])
            expect(() => parseArgs()).toThrow('-bi requires a source id')

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--build-index-all', '--build-index', 'world'])
            expect(() => parseArgs()).toThrow('--build-index-all cannot be used with --build-index')

            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--cluster-workers', '0'])
            expect(() => parseArgs()).toThrow('--cluster-workers must be a positive integer')
        })

        it('parses port option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--port', '8080'])

            expect(parseArgs().port).toBe(8080)
        })

        it('parses short port option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-p', '3000'])

            expect(parseArgs().port).toBe(3000)
        })

        it('parses config option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--config', 'app.json'])

            expect(parseArgs().configPath).toBe(path.resolve(process.cwd(), 'app.json'))
        })

        it('parses short config option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '-c', 'app.json'])

            expect(parseArgs().configPath).toBe(path.resolve(process.cwd(), 'app.json'))
        })

        it('parses config equals option', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--config=app.json'])

            expect(parseArgs().configPath).toBe(path.resolve(process.cwd(), 'app.json'))
        })

        it('throws when port value is missing', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--port'])

            expect(() => parseArgs()).toThrow('--port requires a port number')
        })

        it('throws when config value is missing', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--config'])

            expect(() => parseArgs()).toThrow('--config requires a config path')
        })

        it('throws when config equals value is empty', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--config='])

            expect(() => parseArgs()).toThrow('--config requires a config path')
        })

        it('throws on unknown argument', () => {
            vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'app', '--unknown'])

            expect(() => parseArgs()).toThrow('Unknown argument: --unknown')
        })
    })

    describe('Singleton', () => {
        class TestSingleton extends Singleton {
            constructor() {
                super(TestSingleton)
            }
        }

        afterEach(() => {
            Singleton.delete(TestSingleton)
        })

        it('returns initialized instance', () => {
            const instance = new TestSingleton()

            expect(TestSingleton.instance()).toBe(instance)
        })

        it('throws when initialized twice', () => {
            new TestSingleton()

            expect(() => new TestSingleton()).toThrow('TestSingleton already initialized')
        })

        it('throws when instance is not initialized', () => {
            expect(() => TestSingleton.instance()).toThrow('TestSingleton not initialized')
        })

        it('allows deleting an initialized singleton', () => {
            new TestSingleton()
            Singleton.delete(TestSingleton)

            expect(() => TestSingleton.instance()).toThrow('TestSingleton not initialized')
        })
    })

    describe('Registry', () => {
        it('sets and gets an item', () => {
            const registry = new Registry<number>('numbers')

            registry.set('one', 1)

            expect(registry.get('one')).toBe(1)
            expect(registry.has('one')).toBe(true)
            expect(registry.all).toEqual([1])
        })

        it('throws when setting a duplicate item', () => {
            const registry = new Registry<number>('numbers')

            registry.set('one', 1)

            expect(() => registry.set('one', 2)).toThrow(
                'Item one already exists in Registry numbers'
            )
        })

        it('throws when item is missing', () => {
            const registry = new Registry<number>('numbers')

            expect(() => registry.get('missing')).toThrow(
                'Item missing not found in Registry numbers'
            )
        })

        it('clears all items', () => {
            const registry = new Registry<number>('numbers')
            registry.set('one', 1)

            registry.clear()

            expect(registry.has('one')).toBe(false)
            expect(registry.all).toEqual([])
        })
    })

    describe('file assertions', () => {
        it('does nothing for undefined file path', () => {
            expect(() => assertExistsFile(undefined)).not.toThrow()
        })

        it('accepts an existing file', () => {
            const file = path.join(tempPath, 'file.txt')
            fs.writeFileSync(file, 'content')

            expect(() => assertExistsFile(file)).not.toThrow()
        })

        it('throws when file does not exist', () => {
            expect(() => assertExistsFile('/missing/file.txt')).toThrow(
                'File not found: /missing/file.txt'
            )
        })

        it('throws when path is not a file', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'))

            expect(() => assertExistsFile(dir)).toThrow(`Not a file: ${dir}`)
        })

        it('accepts an existing directory', () => {
            expect(() => assertExistsDir(tempPath)).not.toThrow()
        })

        it('throws when directory does not exist', () => {
            expect(() => assertExistsDir('/missing/dir')).toThrow(
                'Directory not found: /missing/dir'
            )
        })

        it('does nothing for undefined directory path', () => {
            expect(() => assertExistsCreateDir(undefined)).not.toThrow()
        })

        it('creates a missing directory', () => {
            const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-')), 'created')

            assertExistsCreateDir(dir)

            expect(fs.existsSync(dir)).toBe(true)
            expect(fs.statSync(dir).isDirectory()).toBe(true)
        })

        it('throws when path exists but is not a directory', () => {
            const file = path.join(tempPath, 'file.txt')
            fs.writeFileSync(file, 'content')

            expect(() => assertExistsCreateDir(file)).toThrow(`Not a directory: ${file}`)
        })
    })

    describe('object helpers', () => {
        it('detects objects', () => {
            expect(isObject({})).toBe(true)
            expect(isObject([])).toBe(true)
            expect(isObject(null)).toBe(false)
            expect(isObject('text')).toBe(false)
        })

        it('detects plain objects', () => {
            expect(isPlainObject({})).toBe(true)
            expect(isPlainObject([])).toBe(false)
            expect(isPlainObject(null)).toBe(false)
        })
    })

    describe('truthy and stringify helpers', () => {
        it('handles truthy values', () => {
            expect(isTruthy(true)).toBe(true)
            expect(isTruthy('x')).toBe(true)
            expect(isTruthy([1])).toBe(true)
        })

        it('handles falsy values and empty arrays', () => {
            expect(isTruthy(false)).toBe(false)
            expect(isTruthy('')).toBe(false)
            expect(isTruthy([])).toBe(false)
            expect(isTruthy(null)).toBe(false)
            expect(isTruthy(undefined)).toBe(false)
        })

        it('stringifies nullish values as empty strings', () => {
            expect(stringify(null)).toBe('')
            expect(stringify(undefined)).toBe('')
        })

        it('stringifies regular values', () => {
            expect(stringify(0)).toBe('0')
            expect(stringify(false)).toBe('false')
            expect(stringify('abc')).toBe('abc')
        })

        it('escapes HTML special characters', () => {
            expect(escape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
        })
    })

    describe('paramsFromUrl', () => {
        it('uppercases query parameter names', () => {
            const params = paramsFromUrl(new URL('https://example.test?a=1&B=2'))

            expect(params.get('A')).toBe('1')
            expect(params.get('B')).toBe('2')
        })

        it('keeps the last value for duplicate parameters after uppercasing', () => {
            const params = paramsFromUrl(new URL('https://example.test?a=1&A=2'))

            expect(params.get('A')).toBe('2')
        })
    })

    describe('parsePort', () => {
        it('returns fallback when value is undefined or empty', () => {
            expect(parsePort(undefined, 8080)).toBe(8080)
            expect(parsePort('', 8080)).toBe(8080)
        })

        it('parses a valid port', () => {
            expect(parsePort('3000', undefined)).toBe(3000)
        })

        it('throws for invalid ports', () => {
            expect(() => parsePort('0', undefined)).toThrow('Invalid PORT: 0')
            expect(() => parsePort('65536', undefined)).toThrow('Invalid PORT: 65536')
            expect(() => parsePort('abc', undefined)).toThrow('Invalid PORT: abc')
        })
    })

    describe('parseNonNegativeInt', () => {
        it('parses valid values', () => {
            expect(parseNonNegativeInt('0', 'WIDTH', 100)).toBe(0)
            expect(parseNonNegativeInt('10', 'WIDTH', 100)).toBe(10)
        })

        it('throws for invalid non-negative integer values', () => {
            expect(() => parseNonNegativeInt('-1', 'WIDTH', 100)).toThrow(
                'WIDTH must be a non-negative integer'
            )
            expect(() => parseNonNegativeInt('1.5', 'WIDTH', 100)).toThrow(
                'WIDTH must be a non-negative integer'
            )
        })

        it('throws when value exceeds maximum', () => {
            expect(() => parseNonNegativeInt('101', 'WIDTH', 100)).toThrow(
                'WIDTH exceeds maximum value 100'
            )
        })
    })

    describe('nonNegativeInteger', () => {
        it('parses valid non-negative integers', () => {
            expect(nonNegativeInteger('0', 'COUNT')).toBe(0)
            expect(nonNegativeInteger('42', 'COUNT')).toBe(42)
        })

        it('throws when value is not digits only', () => {
            expect(() => nonNegativeInteger('-1', 'COUNT')).toThrow(
                'COUNT must be a non-negative integer'
            )
            expect(() => nonNegativeInteger('1.5', 'COUNT')).toThrow(
                'COUNT must be a non-negative integer'
            )
            expect(() => nonNegativeInteger('abc', 'COUNT')).toThrow(
                'COUNT must be a non-negative integer'
            )
        })

        it('throws when value is outside safe integer range', () => {
            expect(() => nonNegativeInteger('9007199254740992', 'COUNT')).toThrow(
                'COUNT is outside the safe integer range'
            )
        })
    })

    describe('parsePositiveInt', () => {
        it('parses valid positive integers', () => {
            expect(parsePositiveInt('1', 'LIMIT', 100)).toBe(1)
            expect(parsePositiveInt('42', 'LIMIT', 100)).toBe(42)
        })

        it('throws for invalid positive integer values', () => {
            expect(() => parsePositiveInt('0', 'LIMIT', 100)).toThrow(
                'LIMIT must be a positive integer'
            )
            expect(() => parsePositiveInt('-1', 'LIMIT', 100)).toThrow(
                'LIMIT must be a positive integer'
            )
            expect(() => parsePositiveInt('abc', 'LIMIT', 100)).toThrow(
                'LIMIT must be a positive integer'
            )
        })

        it('throws when value exceeds maximum', () => {
            expect(() => parsePositiveInt('101', 'LIMIT', 100)).toThrow(
                'LIMIT exceeds maximum value 100'
            )
        })
    })

    describe('parsePixelIndex', () => {
        it('parses a valid pixel index', () => {
            expect(parsePixelIndex('0', 'x', 10)).toBe(0)
            expect(parsePixelIndex('9', 'x', 10)).toBe(9)
        })

        it('throws when pixel index is missing', () => {
            expect(() => parsePixelIndex(undefined, 'x', 10)).toThrow('x is required')
            expect(() => parsePixelIndex('', 'x', 10)).toThrow('x is required')
        })

        it('throws when pixel index is outside bounds', () => {
            expect(() => parsePixelIndex('-1', 'x', 10)).toThrow(
                'x must be an integer pixel index between 0 and 9'
            )
            expect(() => parsePixelIndex('10', 'x', 10)).toThrow(
                'x must be an integer pixel index between 0 and 9'
            )
            expect(() => parsePixelIndex('1.5', 'x', 10)).toThrow(
                'x must be an integer pixel index between 0 and 9'
            )
        })
    })
})
