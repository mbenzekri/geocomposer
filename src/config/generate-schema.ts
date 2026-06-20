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
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)

const localDefsRefSchema: JsonObject = {
    type: 'string',
    pattern: '^#/\\$defs(?:/[^\\s]+)+$'
}

const envSchemaByKind = {
    string: {
        type: 'string',
        pattern: '^\\$s\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$'
    },
    integer: {
        type: 'string',
        pattern: '^\\$i\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$'
    },
    number: {
        type: 'string',
        pattern: '^\\$f\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$'
    },
    boolean: {
        type: 'string',
        pattern: '^\\$b\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$'
    }
} satisfies Record<string, JsonObject>

const embeddedEnvStringSchema: JsonObject = {
    type: 'string',
    pattern: '\\$[sifb]\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}'
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

const getEnumKind = (values: Json[]): string | undefined => {
    if (values.length === 0) {
        return undefined
    }

    if (values.every(value => typeof value === 'string')) {
        return 'string'
    }

    if (values.every(value => typeof value === 'number')) {
        return values.every(value => Number.isInteger(value))
            ? 'integer'
            : 'number'
    }

    if (values.every(value => typeof value === 'boolean')) {
        return 'boolean'
    }

    return undefined
}

const getSchemaKinds = (
    schema: JsonObject,
    root: JsonObject,
    seen = new Set<string>()
): Set<string> => {
    const kinds = new Set<string>()

    if (typeof schema.type === 'string') {
        kinds.add(schema.type)
    }

    if (typeof schema.const === 'string') {
        kinds.add('string')
    }

    if (typeof schema.const === 'number') {
        kinds.add(Number.isInteger(schema.const) ? 'integer' : 'number')
    }

    if (typeof schema.const === 'boolean') {
        kinds.add('boolean')
    }

    if (Array.isArray(schema.enum)) {
        const enumKind = getEnumKind(schema.enum)

        if (enumKind) {
            kinds.add(enumKind)
        }
    }

    if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
        seen.add(schema.$ref)

        const target = getByPointer(root, schema.$ref)

        if (isObject(target)) {
            for (const kind of getSchemaKinds(target, root, seen)) {
                kinds.add(kind)
            }
        }
    }

    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        if (Array.isArray(schema[key])) {
            for (const subSchema of schema[key]) {
                if (isObject(subSchema)) {
                    for (const kind of getSchemaKinds(subSchema, root, seen)) {
                        kinds.add(kind)
                    }
                }
            }
        }
    }

    return kinds
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

const isArrayLikeSchema = (
    schema: JsonObject,
    root: JsonObject,
    seen = new Set<string>()
): boolean => {
    if (
        schema.type === 'array' ||
        'items' in schema ||
        'prefixItems' in schema ||
        'contains' in schema
    ) {
        return true
    }

    if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
        seen.add(schema.$ref)

        const target = getByPointer(root, schema.$ref)

        return isObject(target) && isArrayLikeSchema(target, root, seen)
    }

    return false
}

const formatEnvVar = (kind: string): string | undefined => {
    if (kind === 'string') {
        return '"$s{ENV_VAR|default}"'
    }

    if (kind === 'integer') {
        return '"$i{ENV_VAR|default}"'
    }

    if (kind === 'number') {
        return '"$f{ENV_VAR|default}"'
    }

    if (kind === 'boolean') {
        return '"$b{ENV_VAR|default}"'
    }

    return undefined
}

const formatKind = (kind: string): string | undefined => {
    if (kind === 'string') {
        return 'string'
    }

    if (kind === 'integer') {
        return 'integer'
    }

    if (kind === 'number') {
        return 'number'
    }

    if (kind === 'boolean') {
        return 'boolean'
    }

    return undefined
}

const formatEnumValues = (values: Json[]): string =>
    values.map(value => JSON.stringify(value)).join(', ')

const getDescriptionSuffix = (
    originalSchema: JsonObject,
    root: JsonObject
): string | undefined => {
    if (Array.isArray(originalSchema.enum)) {
        const enumKind = getEnumKind(originalSchema.enum)
        const envVar = enumKind ? formatEnvVar(enumKind) : undefined

        if (envVar) {
            return `(${formatEnumValues(originalSchema.enum)} or ${envVar})`
        }
    }

    const kinds = getSchemaKinds(originalSchema, root)
    const primitiveKinds = ['string', 'integer', 'number', 'boolean']
        .filter(kind => kinds.has(kind))

    if (primitiveKinds.length === 1) {
        const kind = primitiveKinds[0]
        const label = formatKind(kind)
        const envVar = formatEnvVar(kind)

        if (label && envVar) {
            return `(${label} or ${envVar})`
        }
    }

    if (isObjectLikeSchema(originalSchema, root)) {
        return '(object or "#/$defs/nom")'
    }

    if (isArrayLikeSchema(originalSchema, root)) {
        return '(array or "#/$defs/nom")'
    }

    return undefined
}

const enrichDescription = (
    schema: JsonObject,
    originalSchema: JsonObject,
    root: JsonObject
): JsonObject => {
    const baseDescription = schema.description
    const suffix = getDescriptionSuffix(originalSchema, root)

    if (typeof baseDescription !== 'string' || !suffix) {
        return clone(schema)
    }

    return {
        ...clone(schema),
        description: `${baseDescription} ${suffix}`
    }
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
        $ref: enrichDescription(localDefsRefSchema, originalSchema, root)
    }

    const mergeSchema: JsonObject = {
        type: 'object',
        required: ['$ref'],
        properties,
        description: transformedSchema.description
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

    return enrichDescription(mergeSchema, originalSchema, root)
}

const withExpansionRules = (
    originalSchema: JsonObject,
    transformedSchema: JsonObject,
    root: JsonObject
): JsonObject => {
    const variants: Json[] = [
        enrichDescription(transformedSchema, originalSchema, root),
        enrichDescription(localDefsRefSchema, originalSchema, root)
    ]

    const schemaKinds = getSchemaKinds(originalSchema, root)

    if (schemaKinds.has('string')) {
        variants.push(
            enrichDescription(envSchemaByKind.string, originalSchema, root),
            enrichDescription(embeddedEnvStringSchema, originalSchema, root)
        )
    }

    if (schemaKinds.has('integer')) {
        variants.push(enrichDescription(envSchemaByKind.integer, originalSchema, root))
    }

    if (schemaKinds.has('number')) {
        variants.push(enrichDescription(envSchemaByKind.number, originalSchema, root))
    }

    if (schemaKinds.has('boolean')) {
        variants.push(enrichDescription(envSchemaByKind.boolean, originalSchema, root))
    }

    if (isObjectLikeSchema(originalSchema, root)) {
        variants.push(makeMergeObjectSchema(originalSchema, transformedSchema, root))
    }

    return {
        anyOf: variants,
        description: enrichDescription(transformedSchema, originalSchema, root).description
    }
}

export const generateSchema = (
    rawSchema: JsonObject
): JsonObject =>
    transformSchema(rawSchema, rawSchema, true) as JsonObject

const main = async () => {
    const rawSchema = JSON.parse(await readFile(inputPath, 'utf8')) as JsonObject
    const generatedSchema = generateSchema(rawSchema)

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