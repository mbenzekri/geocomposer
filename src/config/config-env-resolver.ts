import process from 'node:process'

type ConfigEnvCode = 's' | 'i' | 'f' | 'b'
type ConfigEnvValue = string | number | boolean

type ConfigEnvPlaceholder = {
    start: number
    end: number
    token: string
    code: ConfigEnvCode
    name: string
    value: ConfigEnvValue
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const INTEGER_PATTERN = /^[+-]?\d+$/
const FLOAT_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/

export class ConfigEnvResolver {
    constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

    resolve<T>(document: T, label = 'configuration'): T {
        return this.resolveValue(document, [], label) as T
    }

    private resolveValue(value: unknown, path: string[], label: string): unknown {
        if (typeof value === 'string') {
            return this.resolveString(value, path, label)
        }

        if (Array.isArray(value)) {
            return value.map((item, index) => this.resolveValue(item, [...path, String(index)], label))
        }

        if (this.isObject(value)) {
            const resolved: Record<string, unknown> = {}
            for (const [key, child] of Object.entries(value)) {
                resolved[key] = this.resolveValue(child, [...path, key], label)
            }
            return resolved
        }

        return value
    }

    private resolveString(value: string, path: string[], label: string): ConfigEnvValue {
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

    private scanPlaceholders(value: string, path: string[], label: string): ConfigEnvPlaceholder[] {
        const placeholders: ConfigEnvPlaceholder[] = []

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

            const name = value.slice(index + 3, closingBrace)
            const token = value.slice(index, closingBrace + 1)
            if (!ENV_NAME_PATTERN.test(name)) {
                throw new Error(
                    `Invalid environment placeholder "${token}" at ${this.formatLocation(path, label)}: variable name must match ${ENV_NAME_PATTERN}`
                )
            }

            placeholders.push({
                start: index,
                end: closingBrace + 1,
                token,
                code,
                name,
                value: this.resolvePlaceholder(code, name, token, path, label)
            })
            index = closingBrace
        }

        return placeholders
    }

    private resolvePlaceholder(
        code: ConfigEnvCode,
        name: string,
        token: string,
        path: string[],
        label: string
    ): ConfigEnvValue {
        const rawValue = this.env[name]
        if (rawValue === undefined) {
            throw new Error(
                `Missing environment variable "${name}" for ${token} at ${this.formatLocation(path, label)}`
            )
        }

        switch (code) {
            case 's':
                return rawValue

            case 'i':
                return this.toInteger(rawValue, name, token, path, label)

            case 'f':
                return this.toFloat(rawValue, name, token, path, label)

            case 'b':
                return this.toBoolean(rawValue, name, token, path, label)
        }
    }

    private toInteger(value: string, name: string, token: string, path: string[], label: string): number {
        const normalized = value.trim()
        if (!INTEGER_PATTERN.test(normalized)) {
            this.throwConversionError(name, token, path, label, 'integer', value)
        }

        const parsed = Number(normalized)
        if (!Number.isSafeInteger(parsed)) {
            this.throwConversionError(name, token, path, label, 'safe integer', value)
        }

        return parsed
    }

    private toFloat(value: string, name: string, token: string, path: string[], label: string): number {
        const normalized = value.trim()
        if (!FLOAT_PATTERN.test(normalized)) {
            this.throwConversionError(name, token, path, label, 'finite number', value)
        }

        const parsed = Number(normalized)
        if (!Number.isFinite(parsed)) {
            this.throwConversionError(name, token, path, label, 'finite number', value)
        }

        return parsed
    }

    private toBoolean(value: string, name: string, token: string, path: string[], label: string): boolean {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'true') return true
        if (normalized === 'false') return false

        this.throwConversionError(name, token, path, label, 'boolean true or false', value)
    }

    private throwConversionError(
        name: string,
        token: string,
        path: string[],
        label: string,
        expected: string,
        value: string
    ): never {
        throw new Error(
            `Invalid environment variable "${name}" for ${token} at ${this.formatLocation(path, label)}: expected ${expected}, got "${value}"`
        )
    }

    private formatLocation(path: string[], label: string): string {
        const pointer = path.length === 0
            ? '/'
            : `/${path.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
        return `${pointer} in ${label}`
    }

    private isEnvCode(value: string | undefined): value is ConfigEnvCode {
        return value === 's' || value === 'i' || value === 'f' || value === 'b'
    }

    private isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}
