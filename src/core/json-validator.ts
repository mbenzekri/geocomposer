import fs from 'node:fs'
import  path from 'node:path' 
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import process from 'node:process'
import { isPlainObject } from './tools.js'

export class JsonValidator<T> {
    private schemaName: string
    private readonly validator: ValidateFunction
    private validatedValue?: T
    get value(): T | undefined {
        return this.validatedValue
    }

    constructor(schema: unknown, name: string) {
        this.schemaName = name
        const document = this.load(schema)
        if (!isPlainObject(document)) {
            throw new Error(`Invalid JSON Schema in ${document.label}: expected an object`)
        }

        const ajv = new Ajv2020({
            allErrors: true,
            strict: false
        })
        this.validator = ajv.compile(document)
    }

    protected transform(document: unknown) : unknown {
        return document
    }

    validate(value: unknown): T {
        const loadedDocument = this.load(value)
        const document = this.transform ? this.transform(loadedDocument) : loadedDocument

        if (this.validator(document)) {
            this.validatedValue = document as T
            return this.validatedValue
        }

        throw new Error(
            `Document validation fail against ${this.schemaName}:\n${this.formatErrors(this.validator.errors ?? [])}`
        )
    }

    private load(input: unknown): any {
        let value: any
        let text: string
        if (typeof input === 'string' && input.length <= 2048) {
            const fullpath = path.resolve(process.cwd(),input)
            if (fs.existsSync(fullpath)) {
                // string is path 
                try {
                    text = fs.readFileSync(fullpath, 'utf8')
                } catch(e:any) {
                    throw new Error(`ERROR: unable to read ${fullpath} JSON file due to ${String(e)}`)
                }
                try {
                    value = JSON.parse(text)
                    return value
                } catch(e:any) {
                    throw new Error(`ERROR: unable to parse ${fullpath} JSON file due to ${String(e)}`)
                }
            } else {
                // string is JSON
                try {
                    value = JSON.parse(input)
                    return value
                } catch(e:any) {
                    throw new Error(`ERROR: unable to parse ${input.substring(0,100)} JSON text due to ${String(e)}`)
                }
            }
        } else {
            // already loaded
            return input
        }

    }

    private formatErrors(errors: ErrorObject[]): string {
        if (errors.length === 0) return '- schema validation failed'

        return errors
            .map((error) => `- ${this.formatError(error)}`)
            .join('\n')
    }

    private formatError(error: ErrorObject): string {
        const path = error.instancePath || '/'
        const property = this.additionalProperty(error)
        const suffix = property ? `: ${property}` : ''

        return `${path} ${error.message ?? 'is invalid'}${suffix}`
    }

    private additionalProperty(error: ErrorObject): string | undefined {
        const params = error.params as { additionalProperty?: unknown }
        return typeof params.additionalProperty === 'string' ? params.additionalProperty : undefined
    }

}
