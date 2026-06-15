import { Registry } from '../core/tools.js'

export type DbDatasetJson = string | {
  schema?: string
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
  srid?: number
  properties?: string[]
}

export type DbDatasetOptions = {
  schema?: string
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
  srid?: number
  properties?: string[]
}

export class DbDataset {
  readonly id: string
  readonly schema?: string
  readonly tableName: string
  readonly geometryColumn?: string
  readonly primaryKey?: string
  readonly srid?: number
  readonly properties?: string[]

  constructor(id: string, options: DbDatasetOptions = {}) {
    this.id = requireNonEmptyString(id, 'database dataset id')
    this.schema = optionalNonEmptyString(options.schema, `database dataset "${this.id}" schema`)
    this.tableName = requireNonEmptyString(options.tableName ?? this.id, `database dataset "${this.id}" tableName`)
    this.geometryColumn = optionalNonEmptyString(options.geometryColumn, `database dataset "${this.id}" geometryColumn`)
    this.primaryKey = optionalNonEmptyString(options.primaryKey, `database dataset "${this.id}" primaryKey`)
    this.srid = options.srid
    this.properties = options.properties?.map((property) =>
      requireNonEmptyString(property, `database dataset "${this.id}" property`)
    )
  }

  static build(label: string, entries: Record<string, DbDatasetJson>): Registry<DbDataset> {
    const registry = new Registry<DbDataset>(label)

    for (const [id, entry] of Object.entries(entries)) {
      const dataset = DbDataset.fromConfig(id, entry)
      registry.set(dataset.id, dataset)
    }

    if (registry.all.length === 0) {
      throw new Error(`${label} must define at least one dataset`)
    }

    return registry
  }

  static fromConfig(id: string, entry: DbDatasetJson): DbDataset {
    if (typeof entry === 'string') {
      return new DbDataset(id, { tableName: entry })
    }

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid database dataset "${id}"`)
    }

    return new DbDataset(id, entry)
  }
}

function optionalNonEmptyString(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label)
}

function requireNonEmptyString(value: string, label: string): string {
  if (value.trim() === '') {
    throw new Error(`${label} must not be empty`)
  }

  return value
}
