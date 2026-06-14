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

  static fromJson(id: string, entry: DbDatasetJson): DbDataset {
    if (typeof entry === 'string') {
      return new DbDataset(id, { tableName: entry })
    }

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid database dataset "${id}"`)
    }

    return new DbDataset(id, entry)
  }
}

export class DbDatasetCatalog {
  private readonly byId: Map<string, DbDataset>

  constructor(
    readonly label: string,
    datasets: DbDataset[]
  ) {
    this.byId = new Map()

    for (const dataset of datasets) {
      if (this.byId.has(dataset.id)) {
        throw new Error(`${label} defines duplicate dataset "${dataset.id}"`)
      }
      this.byId.set(dataset.id, dataset)
    }

    if (this.byId.size === 0) {
      throw new Error(`${label} must define at least one dataset`)
    }
  }

  static fromConfig(label: string, entries: Record<string, DbDatasetJson>): DbDatasetCatalog {
    const datasets = Object.entries(entries).map(([id, entry]) => DbDataset.fromJson(id, entry))
    return new DbDatasetCatalog(label, datasets)
  }

  get all(): readonly DbDataset[] {
    return [...this.byId.values()]
  }

  get(id: string): DbDataset {
    const datasetId = requireNonEmptyString(id, 'database dataset id')
    const dataset = this.byId.get(datasetId)

    if (!dataset) {
      throw new Error(`${this.label} has no dataset "${datasetId}"`)
    }

    return dataset
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
