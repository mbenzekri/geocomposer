type JsonObject = Record<string, unknown>

const DEFINITION_SECTION_KEY = '$defs'
const DEFINITION_POINTER_KEY = '$defs'
const REF_KEY = '$ref'

export class ConfigDefinitionResolver {
    private definitions: JsonObject = {}

    constructor(private readonly subject = 'config') {}

    resolve<T>(document: T, label = 'configuration'): T {
        if (!this.isPlainObject(document)) return document

        this.definitions = this.collectDefinitions(document, label)
        return this.resolveValue(document, [], label, []) as T
    }

    private collectDefinitions(document: JsonObject, label: string): JsonObject {
        const definitions: JsonObject = {}

        const section = document[DEFINITION_SECTION_KEY]
        if (section === undefined) return definitions

        if (!this.isPlainObject(section)) {
            throw new Error(`Invalid ${this.subject} definitions at /${DEFINITION_SECTION_KEY} in ${label}: expected an object`)
        }

        for (const [name, value] of Object.entries(section)) {
            if (Object.hasOwn(definitions, name)) {
                throw new Error(`Duplicate ${this.subject} definition "${name}" in ${label}`)
            }

            definitions[name] = value
        }

        return definitions
    }

    private resolveValue(value: unknown, path: string[], label: string, stack: string[]): unknown {
        if (typeof value === 'string') {
            if (this.isDefinitionPointer(value)) {
                return this.resolvePointer(value, path, label, stack)
            }

            return value
        }

        if (Array.isArray(value)) {
            return value.map((item, index) => this.resolveValue(item, [...path, String(index)], label, stack))
        }

        if (!this.isPlainObject(value)) return value

        if (path.length === 0) {
            return this.resolveRootObject(value, label, stack)
        }

        if (Object.hasOwn(value, REF_KEY)) {
            return this.resolveRefObject(value, path, label, stack)
        }

        return this.resolveObjectEntries(value, path, label, stack)
    }

    private resolveRootObject(value: JsonObject, label: string, stack: string[]): JsonObject {
        const resolved: JsonObject = {}

        for (const [key, child] of Object.entries(value)) {
            if (this.isDefinitionSectionKey(key)) continue

            resolved[key] = this.resolveValue(child, [key], label, stack)
        }

        return resolved
    }

    private resolveObjectEntries(value: JsonObject, path: string[], label: string, stack: string[]): JsonObject {
        const resolved: JsonObject = {}

        for (const [key, child] of Object.entries(value)) {
            resolved[key] = this.resolveValue(child, [...path, key], label, stack)
        }

        return resolved
    }

    private resolveRefObject(value: JsonObject, path: string[], label: string, stack: string[]): unknown {
        const pointer = value[REF_KEY]
        if (typeof pointer !== 'string') {
            throw new Error(`Invalid ${this.subject} reference at ${this.formatLocation(path, label)}: "$ref" must be a string`)
        }

        if (!this.isDefinitionPointer(pointer)) {
            return this.resolveObjectEntries(value, path, label, stack)
        }

        const referenced = this.resolvePointer(pointer, path, label, stack)
        const overrideEntries = Object.entries(value).filter(([key]) => key !== REF_KEY)
        if (overrideEntries.length === 0) return referenced

        if (!this.isPlainObject(referenced)) {
            throw new Error(
                `Invalid ${this.subject} reference at ${this.formatLocation(path, label)}: "${pointer}" must resolve to an object when local overrides are provided`
            )
        }

        const overrides = this.resolveObjectEntries(Object.fromEntries(overrideEntries), path, label, stack)
        return this.mergeObjects(referenced, overrides)
    }

    private resolvePointer(pointer: string, path: string[], label: string, stack: string[]): unknown {
        const tokens = this.parseDefinitionPointer(pointer, path, label)
        const normalizedPointer = this.formatDefinitionPointer(tokens)

        if (stack.includes(normalizedPointer)) {
            throw new Error(
                `Circular ${this.subject} definition reference at ${this.formatLocation(path, label)}: ${[...stack, normalizedPointer].join(' -> ')}`
            )
        }

        let value: unknown = this.definitions
        for (const token of tokens) {
            value = this.readPointerToken(value, token, pointer, path, label)
        }

        return this.resolveValue(this.clone(value), path, label, [...stack, normalizedPointer])
    }

    private readPointerToken(
        value: unknown,
        token: string,
        pointer: string,
        path: string[],
        label: string
    ): unknown {
        if (this.isPlainObject(value) && Object.hasOwn(value, token)) {
            return value[token]
        }

        if (Array.isArray(value)) {
            const index = Number(token)
            if (Number.isSafeInteger(index) && index >= 0 && String(index) === token && index < value.length) {
                return value[index]
            }
        }

        throw new Error(`Unknown ${this.subject} definition pointer "${pointer}" at ${this.formatLocation(path, label)}`)
    }

    private parseDefinitionPointer(pointer: string, path: string[], label: string): string[] {
        if (!pointer.startsWith('#/')) {
            throw new Error(`Invalid ${this.subject} definition pointer "${pointer}" at ${this.formatLocation(path, label)}`)
        }

        const tokens = pointer.slice(2).split('/').map((token) => this.unescapePointerToken(token, pointer, path, label))
        const section = tokens.shift()
        if (section !== DEFINITION_POINTER_KEY) {
            throw new Error(
                `Invalid ${this.subject} definition pointer "${pointer}" at ${this.formatLocation(path, label)}: expected #/$defs/<name>`
            )
        }

        if (tokens.length === 0) {
            throw new Error(
                `Invalid ${this.subject} definition pointer "${pointer}" at ${this.formatLocation(path, label)}: expected a definition name`
            )
        }

        return tokens
    }

    private unescapePointerToken(token: string, pointer: string, path: string[], label: string): string {
        const invalidEscape = token.match(/~(?![01])/)
        if (invalidEscape) {
            throw new Error(`Invalid JSON pointer escape in "${pointer}" at ${this.formatLocation(path, label)}`)
        }

        return token.replace(/~1/g, '/').replace(/~0/g, '~')
    }

    private formatDefinitionPointer(tokens: string[]): string {
        return `#/$defs/${tokens.map((token) => token.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
    }

    private mergeObjects(base: JsonObject, overrides: JsonObject): JsonObject {
        const merged: JsonObject = this.clone(base) as JsonObject

        for (const [key, overrideValue] of Object.entries(overrides)) {
            const baseValue = merged[key]
            if (this.isPlainObject(baseValue) && this.isPlainObject(overrideValue)) {
                merged[key] = this.mergeObjects(baseValue, overrideValue)
                continue
            }

            merged[key] = this.clone(overrideValue)
        }

        return merged
    }

    private clone(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((item) => this.clone(item))

        if (this.isPlainObject(value)) {
            const cloned: JsonObject = {}
            for (const [key, child] of Object.entries(value)) {
                cloned[key] = this.clone(child)
            }
            return cloned
        }

        return value
    }

    private isDefinitionPointer(value: string): boolean {
        if (!value.startsWith('#/')) return false
        const sectionEnd = value.indexOf('/', 2)
        const section = sectionEnd < 0 ? value.slice(2) : value.slice(2, sectionEnd)
        return section === DEFINITION_POINTER_KEY
    }

    private isDefinitionSectionKey(key: string): boolean {
        return key === DEFINITION_SECTION_KEY
    }

    private formatLocation(path: string[], label: string): string {
        const pointer = path.length === 0
            ? '/'
            : `/${path.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
        return `${pointer} in ${label}`
    }

    private isPlainObject(value: unknown): value is JsonObject {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}
