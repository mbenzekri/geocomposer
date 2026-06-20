import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Json =
    | undefined
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json }

type JsonObject = { [key: string]: Json }

const inputPath = resolve(import.meta.dirname, 'config.schema.json')
const outputPath = resolve(import.meta.dirname, 'config-and-rules.schema.json')

const clone = <T extends Json>(value: T): T =>
    JSON.parse(JSON.stringify(value)) as T

const isObject = (value: Json): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const localDefsRefSchema: JsonObject = {
    type: 'string',
    pattern: '^#/\\$defs(?:/[^\\s]+)+$',
    description: 'Référence locale vers une définition de configuration, par exemple #/$defs/defaultTileset'
}

const envSchemaByKind = {
    string: {
        type: 'string',
        pattern: '^\\$s\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
        description: 'Variable d’environnement chaîne : $s{VAR} ou $s{VAR|default}'
    },
    integer: {
        type: 'string',
        pattern: '^\\$i\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
        description: 'Variable d’environnement entière : $i{VAR} ou $i{VAR|3000}'
    },
    number: {
        type: 'string',
        pattern: '^\\$f\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
        description: 'Variable d’environnement numérique : $f{VAR} ou $f{VAR|1.5}'
    },
    boolean: {
        type: 'string',
        pattern: '^\\$b\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
        description: 'Variable d’environnement booléenne : $b{VAR} ou $b{VAR|false}'
    }
} satisfies Record<string, JsonObject>

const embeddedEnvStringSchema: JsonObject = {
    type: 'string',
    pattern: '\\$[sifb]\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}',
    description: 'Chaîne contenant une ou plusieurs variables d’environnement typées'
}

const anyConfigValueSchema: JsonObject = {
    description: 'Valeur JSON libre utilisable dans la section racine $defs de la configuration'
}

const refPointerToPath = (ref: string): string[] | undefined => {
    if (!ref.startsWith('#/')) {
        return undefined
    }

    return ref
        .slice(2)
        .split('/')
        .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

const getByPointer = (root: JsonObject, ref: string): Json | undefined => {
    const path = refPointerToPath(ref)

    if (!path) {
        return undefined
    }

    let current: Json = root

    for (const key of path) {
        if (!isObject(current) || !(key in current)) {
            return undefined
        }

        current = current[key]
    }

    return current
}

const getSchemaKind = (
    schema: JsonObject,
    root: JsonObject,
    seen = new Set<string>()
): string | undefined => {
    if (typeof schema.type === 'string') {
        return schema.type
    }

    if (typeof schema.const === 'string') {
        return 'string'
    }

    if (typeof schema.const === 'number') {
        return Number.isInteger(schema.const) ? 'integer' : 'number'
    }

    if (typeof schema.const === 'boolean') {
        return 'boolean'
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        if (schema.enum.every(value => typeof value === 'string')) {
            return 'string'
        }

        if (schema.enum.every(value => typeof value === 'number')) {
            return schema.enum.every(value => Number.isInteger(value))
                ? 'integer'
                : 'number'
        }

        if (schema.enum.every(value => typeof value === 'boolean')) {
            return 'boolean'
        }
    }

    if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
        seen.add(schema.$ref)

        const target = getByPointer(root, schema.$ref)

        if (isObject(target ?? null)) {
            return getSchemaKind(target as JsonObject, root, seen)
        }
    }

    return undefined
}

const isObjectLikeSchema = (
    schema: JsonObject,
    root: JsonObject,
    seen = new Set<string>()
): boolean => {
    if (
        schema.type === 'object' ||
        'properties' in schema ||
        'additionalProperties' in schema ||
        'unevaluatedProperties' in schema ||
        'allOf' in schema
    ) {
        return true
    }

    if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
        seen.add(schema.$ref)

        const target = getByPointer(root, schema.$ref)

        return isObject(target) && isObjectLikeSchema(target, root, seen)
    }

    return false
}

export const transformSchema = (
    schema: Json,
    root: JsonObject,
    isRoot = false
): Json => {
    if (!isObject(schema)) {
        return schema
    }

    const transformed: JsonObject = {}

    for (const [key, value] of Object.entries(schema)) {
        if (key === '$ref') {
            transformed[key] = clone(value)
            continue
        }

        if (
            [
                'properties',
                'patternProperties',
                'dependentSchemas',
                '$defs',
                'definitions'
            ].includes(key) &&
            isObject(value)
        ) {
            transformed[key] = Object.fromEntries(
                Object.entries(value).map(([propertyName, propertySchema]) => [
                    propertyName,
                    transformSchema(propertySchema, root)
                ])
            )
            continue
        }

        if (
            [
                'items',
                'additionalProperties',
                'unevaluatedProperties',
                'contains',
                'propertyNames',
                'not',
                'if',
                'then',
                'else'
            ].includes(key)
        ) {
            transformed[key] = transformSchema(value, root)
            continue
        }

        if (
            ['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) &&
            Array.isArray(value)
        ) {
            transformed[key] = value.map(item => transformSchema(item, root))
            continue
        }

        transformed[key] = clone(value)
    }

    if (isRoot) {
        transformed.$id = 'https://geocomposer.local/config-and-rules.schema.json'
        transformed.title = 'GeoComposer config with expansion rules'
        transformed.description =
            'Schema éditeur autorisant la configuration GeoComposer avant expansion des $defs, $ref locaux et variables d’environnement'

        const properties = isObject(transformed.properties)
            ? transformed.properties
            : {}

        properties.$defs = {
            type: 'object',
            additionalProperties: anyConfigValueSchema,
            description: 'Définitions de configuration réutilisables avant expansion'
        }

        transformed.properties = properties

        return transformed
    }

    return withExpansionRules(schema, transformed, root)
}

const collectProperties = (
    schema: JsonObject,
    root: JsonObject,
    seen = new Set<string>()
): JsonObject => {
    const properties: JsonObject = {}

    if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
        seen.add(schema.$ref)

        const target = getByPointer(root, schema.$ref)

        if (isObject(target)) {
            Object.assign(properties, collectProperties(target, root, seen))
        }
    }

    if (Array.isArray(schema.allOf)) {
        for (const subSchema of schema.allOf) {
            if (isObject(subSchema)) {
                Object.assign(properties, collectProperties(subSchema, root, seen))
            }
        }
    }

    if (isObject(schema.properties)) {
        for (const [key, value] of Object.entries(schema.properties)) {
            properties[key] = transformSchema(value, root)
        }
    }

    return properties
}

const makeMergeObjectSchema = (
    originalSchema: JsonObject,
    transformedSchema: JsonObject,
    root: JsonObject
): JsonObject => {
    const collectedProperties = collectProperties(originalSchema, root)
    const transformedProperties = isObject(transformedSchema.properties)
        ? transformedSchema.properties
        : {}

    const properties: JsonObject = {
        ...collectedProperties,
        ...transformedProperties,
        $ref: localDefsRefSchema
    }

    const mergeSchema: JsonObject = {
        type: 'object',
        required: ['$ref'],
        properties,
        description: 'Objet de configuration fusionné avec une définition locale $defs via $ref'
    }

    if (originalSchema.additionalProperties === false) {
        mergeSchema.additionalProperties = false
    } else if (isObject(transformedSchema.additionalProperties)) {
        mergeSchema.additionalProperties = transformedSchema.additionalProperties
    } else if (transformedSchema.additionalProperties === false) {
        mergeSchema.additionalProperties = false
    }

    if (transformedSchema.unevaluatedProperties === false) {
        mergeSchema.unevaluatedProperties = false
    }

    return mergeSchema
}

const withExpansionRules = (
    originalSchema: JsonObject,
    transformedSchema: JsonObject,
    root: JsonObject
): JsonObject => {
    const variants: Json[] = [transformedSchema, localDefsRefSchema]
    const schemaKind = getSchemaKind(originalSchema, root)

    if (schemaKind === 'string') {
        variants.push(envSchemaByKind.string, embeddedEnvStringSchema)
    }

    if (schemaKind === 'integer') {
        variants.push(envSchemaByKind.integer)
    }

    if (schemaKind === 'number') {
        variants.push(envSchemaByKind.number)
    }

    if (schemaKind === 'boolean') {
        variants.push(envSchemaByKind.boolean)
    }

    if (isObjectLikeSchema(originalSchema, root)) {
        variants.push(makeMergeObjectSchema(originalSchema, transformedSchema, root))
    }

    return {
        anyOf: variants,
        description: transformedSchema.description
    }
}

export const generateSchema = (
    rawSchema: JsonObject
): JsonObject =>
    transformSchema(rawSchema, rawSchema, true) as JsonObject

const main = async () => {
    const rawSchema = JSON.parse(await readFile(inputPath, 'utf8')) as JsonObject
    const generatedSchema = transformSchema(rawSchema, rawSchema, true)
    await writeFile(
        outputPath,
        `${JSON.stringify(generatedSchema, null, 2)}\n`,
        'utf8'
    )

    console.log(`Schema generated: ${outputPath}`)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}