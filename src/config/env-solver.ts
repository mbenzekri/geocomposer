import process from 'node:process'
import { isPlainObject } from '../core/tools.js'

type EnvCode = 's' | 'i' | 'f' | 'b'
type EnvValue = string | number | boolean

type EnvPlaceholder = {
    start: number
    end: number
    token: string
    code: EnvCode
    name: string
    value: EnvValue
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const INTEGER_PATTERN = /^[+-]?\d+$/
const FLOAT_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/

type EnvPlaceholderParts = {
    name: string
    defaultValue?: string
}

type EnvValueSource = 'environment variable' | 'default value'

export class EnvSolver {
    constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

    solve<T>(document: T, label = 'configuration'): T {
        return this.solveValue(document, [], label) as T
    }

    private solveValue(value: unknown, path: string[], label: string): unknown {
        if (typeof value === 'string') {
            return this.solveString(value, path, label)
        }

        if (Array.isArray(value)) {
            return value.map((item, index) => this.solveValue(item, [...path, String(index)], label))
        }

        if (isPlainObject(value)) {
            const resolved: Record<string, unknown> = {}
            for (const [key, child] of Object.entries(value)) {
                resolved[key] = this.solveValue(child, [...path, key], label)
            }
            return resolved
        }

        return value
    }

    private solveString(value: string, path: string[], label: string): EnvValue {
        const placeholders = this.scanPlaceholders(value, path, label)
        if (placeholders.length === 0) return value

        const onlyPlaceholder = placeholders.length === 1
            && placeholders[0].start === 0
            && placeholders[0].end === value.length
        if (onlyPlaceholder) return placeholders[0].value

        let resolved = ''
        let offset = 0
        for (const placeholder of placeholders) {
            resolved += value.slice(offset, placeholder.start)
            resolved += String(placeholder.value)
            offset = placeholder.end
        }

        return resolved + value.slice(offset)
    }

    private scanPlaceholders(value: string, path: string[], label: string): EnvPlaceholder[] {
        const placeholders: EnvPlaceholder[] = []

        for (let index = 0; index < value.length; index++) {
            if (value[index] !== '$') continue

            const code = value[index + 1]
            if (code && value[index + 2] === '{' && !this.isEnvCode(code)) {
                const tokenEnd = value.indexOf('}', index + 3)
                const token = value.slice(index, tokenEnd < 0 ? value.length : tokenEnd + 1)
                throw new Error(
                    `Invalid environment placeholder at ${this.formatLocation(path, label)}: unknown type "${code}" in "${token}"; expected one of s, i, f, b`
                )
            }

            if (!this.isEnvCode(code) || value[index + 2] !== '{') continue

            const closingBrace = value.indexOf('}', index + 3)
            if (closingBrace < 0) {
                throw new Error(
                    `Invalid environment placeholder at ${this.formatLocation(path, label)}: missing closing "}" in "${value.slice(index)}"`
                )
            }

            const token = value.slice(index, closingBrace + 1)
            const { name, defaultValue } = this.parsePlaceholderParts(
                value.slice(index + 3, closingBrace),
                token,
                path,
                label
            )

            placeholders.push({
                start: index,
                end: closingBrace + 1,
                token,
                code,
                name,
                value: this.solvePlaceholder(code, name, defaultValue, token, path, label)
            })
            index = closingBrace
        }

        return placeholders
    }

    private parsePlaceholderParts(
        content: string,
        token: string,
        path: string[],
        label: string
    ): EnvPlaceholderParts {
        const separator = content.indexOf('|')
        const name = separator < 0 ? content : content.slice(0, separator)
        const defaultValue = separator < 0 ? undefined : content.slice(separator + 1)

        if (!ENV_NAME_PATTERN.test(name)) {
            throw new Error(
                `Invalid environment placeholder "${token}" at ${this.formatLocation(path, label)}: variable name must match ${ENV_NAME_PATTERN}`
            )
        }

        return { name, defaultValue }
    }

    private solvePlaceholder(
        code: EnvCode,
        name: string,
        defaultValue: string | undefined,
        token: string,
        path: string[],
        label: string
    ): EnvValue {
        const rawValue = this.env[name]
        const value = rawValue ?? defaultValue
        if (value === undefined) {
            throw new Error(
                `Missing environment variable "${name}" for ${token} at ${this.formatLocation(path, label)}`
            )
        }

        const source: EnvValueSource = rawValue === undefined ? 'default value' : 'environment variable'

        switch (code) {
            case 's':
                return value

            case 'i':
                return this.toInteger(value, name, token, path, label, source)

            case 'f':
                return this.toFloat(value, name, token, path, label, source)

            case 'b':
                return this.toBoolean(value, name, token, path, label, source)
        }
    }

    private toInteger(
        value: string,
        name: string,
        token: string,
        path: string[],
        label: string,
        source: EnvValueSource
    ): number {
        const normalized = value.trim()
        if (!INTEGER_PATTERN.test(normalized)) {
            this.throwConversionError(name, token, path, label, 'integer', value, source)
        }

        const parsed = Number(normalized)
        if (!Number.isSafeInteger(parsed)) {
            this.throwConversionError(name, token, path, label, 'safe integer', value, source)
        }

        return parsed
    }

    private toFloat(
        value: string,
        name: string,
        token: string,
        path: string[],
        label: string,
        source: EnvValueSource
    ): number {
        const normalized = value.trim()
        if (!FLOAT_PATTERN.test(normalized)) {
            this.throwConversionError(name, token, path, label, 'finite number', value, source)
        }

        const parsed = Number(normalized)
        if (!Number.isFinite(parsed)) {
            this.throwConversionError(name, token, path, label, 'finite number', value, source)
        }

        return parsed
    }

    private toBoolean(
        value: string,
        name: string,
        token: string,
        path: string[],
        label: string,
        source: EnvValueSource
    ): boolean {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'true') return true
        if (normalized === 'false') return false

        this.throwConversionError(name, token, path, label, 'boolean true or false', value, source)
    }

    private throwConversionError(
        name: string,
        token: string,
        path: string[],
        label: string,
        expected: string,
        value: string,
        source: EnvValueSource
    ): never {
        const valueSource = source === 'default value'
            ? `default value for ${token}`
            : `environment variable "${name}" for ${token}`
        throw new Error(
            `Invalid ${valueSource} at ${this.formatLocation(path, label)}: expected ${expected}, got "${value}"`
        )
    }

    private formatLocation(path: string[], label: string): string {
        const pointer = path.length === 0
            ? '/'
            : `/${path.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
        return `${pointer} in ${label}`
    }

    private isEnvCode(value: string | undefined): value is EnvCode {
        return value === 's' || value === 'i' || value === 'f' || value === 'b'
    }

    private isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}
