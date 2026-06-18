import { describe, expect, it } from 'vitest'
import { EnvSolver } from '../../src/config/env-solver.js'

describe('EnvSolver - depth and limits', () => {
    it('resolves placeholders deeply nested in objects', () => {
        const solver = new EnvSolver({
            HOST: 'localhost'
        })

        const document = {
            level1: {
                level2: {
                    level3: {
                        level4: {
                            host: '$s{HOST}'
                        }
                    }
                }
            }
        }

        const result = solver.solve(document)

        expect(result).toEqual({
            level1: {
                level2: {
                    level3: {
                        level4: {
                            host: 'localhost'
                        }
                    }
                }
            }
        })
    })

    it('resolves placeholders deeply nested in arrays', () => {
        const solver = new EnvSolver({
            PORT: '8080'
        })

        const document = [
            [
                [
                    [
                        '$i{PORT}'
                    ]
                ]
            ]
        ]

        const result = solver.solve(document)

        expect(result).toEqual([
            [
                [
                    [
                        8080
                    ]
                ]
            ]
        ])
    })

    it('resolves many placeholders in a single string', () => {
        const solver = new EnvSolver({
            A: 'a',
            B: 'b',
            C: 'c',
            D: 'd',
            E: 'e'
        })

        const result = solver.solve({
            value: '$s{A}-$s{B}-$s{C}-$s{D}-$s{E}'
        })

        expect(result).toEqual({
            value: 'a-b-c-d-e'
        })
    })

    it('resolves a large mixed structure', () => {
        const solver = new EnvSolver({
            HOST: 'localhost',
            PORT: '5432',
            SSL: 'true'
        })

        const document = {
            database: {
                host: '$s{HOST}',
                port: '$i{PORT}',
                ssl: '$b{SSL}'
            },
            replicas: [
                {
                    host: '$s{HOST}',
                    port: '$i{PORT}'
                },
                {
                    host: '$s{HOST}',
                    port: '$i{PORT}'
                }
            ]
        }

        const result = solver.solve(document)

        expect(result).toEqual({
            database: {
                host: 'localhost',
                port: 5432,
                ssl: true
            },
            replicas: [
                {
                    host: 'localhost',
                    port: 5432
                },
                {
                    host: 'localhost',
                    port: 5432
                }
            ]
        })
    })

    it('throws when the placeholder type is unknown', () => {
        const solver = new EnvSolver()

        expect(() => solver.solve({
            value: '$x{HOST}'
        })).toThrow(
            'Invalid environment placeholder at /value in configuration: unknown type "x" in "$x{HOST}"; expected one of s, i, f, b'
        )
    })

    it('throws when the placeholder is missing a closing brace', () => {
        const solver = new EnvSolver()

        expect(() => solver.solve({
            value: '$s{HOST'
        })).toThrow(
            'Invalid environment placeholder at /value in configuration: missing closing "}" in "$s{HOST"'
        )
    })

    it('throws when the variable name is invalid', () => {
        const solver = new EnvSolver()

        expect(() => solver.solve({
            value: '$s{1HOST}'
        })).toThrow(
            'Invalid environment placeholder "$s{1HOST}" at /value in configuration: variable name must match /^[A-Za-z_][A-Za-z0-9_]*$/'
        )
    })

    it('throws when the environment variable is missing and no default value is provided', () => {
        const solver = new EnvSolver({})

        expect(() => solver.solve({
            value: '$s{HOST}'
        })).toThrow(
            'Missing environment variable "HOST" for $s{HOST} at /value in configuration'
        )
    })

    it('throws when an integer placeholder receives a non-integer value', () => {
        const solver = new EnvSolver({
            PORT: '12.5'
        })

        expect(() => solver.solve({
            port: '$i{PORT}'
        })).toThrow(
            'Invalid environment variable "PORT" for $i{PORT} at /port in configuration: expected integer, got "12.5"'
        )
    })

    it('throws when an integer placeholder receives an unsafe integer', () => {
        const solver = new EnvSolver({
            PORT: '9007199254740992'
        })

        expect(() => solver.solve({
            port: '$i{PORT}'
        })).toThrow(
            'Invalid environment variable "PORT" for $i{PORT} at /port in configuration: expected safe integer, got "9007199254740992"'
        )
    })

    it('throws when a float placeholder receives a non-number value', () => {
        const solver = new EnvSolver({
            RATIO: 'abc'
        })

        expect(() => solver.solve({
            ratio: '$f{RATIO}'
        })).toThrow(
            'Invalid environment variable "RATIO" for $f{RATIO} at /ratio in configuration: expected finite number, got "abc"'
        )
    })

    it('throws when a boolean placeholder receives an invalid value', () => {
        const solver = new EnvSolver({
            ENABLED: 'yes'
        })

        expect(() => solver.solve({
            enabled: '$b{ENABLED}'
        })).toThrow(
            'Invalid environment variable "ENABLED" for $b{ENABLED} at /enabled in configuration: expected boolean true or false, got "yes"'
        )
    })

})
