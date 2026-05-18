import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import proj4 from 'proj4'
import type { CrsCode } from '../core/types.js'
import type { WmsAppOptions, WmsLayer, WmsLayerStyle, WmsService } from '../ogc/wms-server.js'
import { GeoJsonSource } from '../source/geojson-source.js'
import { GmlSource, type GmlAxisOrder } from '../source/gml-source.js'
import { GpkgSource } from '../source/gpkg-source.js'
import { ShpSource } from '../source/shp-source.js'
import type { Source } from '../source/source.js'
import { createDynamicStyleFn, type DynamicStyleJson } from '../style/dynamic-style.js'
import { defaultStyleFn } from '../style/default-style.js'
import type { StyleFn } from '../style/style-fn.js'
import { worldStyleFn } from '../style/world-style.js'

export type CrsJson = {
  code: CrsCode
  proj4?: string
  aliases?: string[]
}

export type GeoJsonSourceJson = {
  type: 'geojson'
  path: string
  crs?: string
  encoding?: BufferEncoding
  highWaterMark?: number
}

export type GmlSourceJson = {
  type: 'gml'
  path: string
  crs?: string
  encoding?: BufferEncoding
  highWaterMark?: number
  featureElementNames?: string[]
  geometryPropertyNames?: string[]
  axisOrder?: GmlAxisOrder
}

export type ShpSourceJson = {
  type: 'shp'
  shpPath: string
  dbfPath: string
  crs?: string
  dbfEncoding?: BufferEncoding
  highWaterMark?: number
}

export type GpkgSourceJson = {
  type: 'gpkg'
  path: string
  crs?: string
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
}

export type SourceJson =
  | GeoJsonSourceJson
  | GmlSourceJson
  | ShpSourceJson
  | GpkgSourceJson

export type BuiltinStyleJson = {
  type: 'builtin'
  name: 'default' | 'world'
  title?: string
  abstract?: string
}

export type DynamicStyleOptionsJson = {
  units?: 'm' | 'dd'
  dotsPerInch?: number
}

export type DynamicStyleFileJson = {
  type: 'dynamic'
  path: string
  name?: string
  title?: string
  abstract?: string
  options?: DynamicStyleOptionsJson
}

export type StyleJson = BuiltinStyleJson | DynamicStyleFileJson

export type LayerJson = {
  name: string
  title?: string
  abstract?: string
  source: string
  style?: string
  styles?: string[]
  crs?: string[]
}

export type ServerJson = {
  port?: number
  path?: string
  maxWidth?: number
  maxHeight?: number
}

export type AppJsonConfig = {
  server?: ServerJson
  service: WmsService
  crs?: Record<string, CrsJson>
  sources: Record<string, SourceJson>
  styles: Record<string, StyleJson>
  layers: LayerJson[]
}

export type LoadedConfig = {
  path: string
  dir: string
  server: Required<ServerJson>
  app: WmsAppOptions
}

const BUILTIN_STYLES: Record<BuiltinStyleJson['name'], StyleFn> = {
  default: defaultStyleFn,
  world: worldStyleFn
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const path = resolve(configPath)
  const dir = dirname(path)
  const config = await readJsonFile<AppJsonConfig>(path)
  const crs = new CrsRegistry(config.crs)
  const sources = createSources(config.sources, dir, crs)
  const styles = await createStyles(config.styles, dir)
  const layers = createLayers(config.layers, sources, styles, crs)
  const appCrs = crs.codes()

  return {
    path,
    dir,
    server: {
      port: config.server?.port ?? 3000,
      path: config.server?.path ?? '/wms',
      maxWidth: config.server?.maxWidth ?? 4096,
      maxHeight: config.server?.maxHeight ?? 4096
    },
    app: {
      path: config.server?.path ?? '/wms',
      maxWidth: config.server?.maxWidth ?? 4096,
      maxHeight: config.server?.maxHeight ?? 4096,
      service: config.service,
      ...(appCrs.length > 0 ? { crs: appCrs } : {}),
      layers
    }
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  let text: string

  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read JSON file ${path}: ${String(error)}`)
  }

  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${String(error)}`)
  }
}

function createSources(
  sourceEntries: Record<string, SourceJson>,
  baseDir: string,
  crs: CrsRegistry
): Map<string, Source> {
  const sources = new Map<string, Source>()

  for (const [id, entry] of Object.entries(sourceEntries)) {
    const source = createSource(id, entry, baseDir, crs)
    sources.set(id, source)
  }

  return sources
}

function createSource(id: string, entry: SourceJson, baseDir: string, crs: CrsRegistry): Source {
  switch (entry.type) {
    case 'geojson':
      return new GeoJsonSource(id, resolve(baseDir, entry.path), {
        crs: crs.resolve(entry.crs),
        encoding: entry.encoding,
        highWaterMark: entry.highWaterMark
      })

    case 'gml':
      return new GmlSource(id, resolve(baseDir, entry.path), {
        crs: crs.resolve(entry.crs),
        encoding: entry.encoding,
        highWaterMark: entry.highWaterMark,
        featureElementNames: entry.featureElementNames,
        geometryPropertyNames: entry.geometryPropertyNames,
        axisOrder: entry.axisOrder
      })

    case 'shp':
      return new ShpSource(
        id,
        resolve(baseDir, entry.shpPath),
        resolve(baseDir, entry.dbfPath),
        {
          crs: crs.resolve(entry.crs),
          dbfEncoding: entry.dbfEncoding,
          highWaterMark: entry.highWaterMark
        }
      )

    case 'gpkg':
      return new GpkgSource(id, resolve(baseDir, entry.path), {
        crs: crs.resolve(entry.crs),
        tableName: entry.tableName,
        geometryColumn: entry.geometryColumn,
        primaryKey: entry.primaryKey
      })
  }
}

async function createStyles(
  styleEntries: Record<string, StyleJson>,
  baseDir: string
): Promise<Map<string, WmsLayerStyle>> {
  const styles = new Map<string, WmsLayerStyle>()

  for (const [id, entry] of Object.entries(styleEntries)) {
    styles.set(id, await createStyle(id, entry, baseDir))
  }

  return styles
}

async function createStyle(id: string, entry: StyleJson, baseDir: string): Promise<WmsLayerStyle> {
  switch (entry.type) {
    case 'builtin':
      return {
        name: id,
        title: entry.title ?? titleFromId(id),
        abstract: entry.abstract,
        style: BUILTIN_STYLES[entry.name]
      }

    case 'dynamic': {
      const json = await readJsonFile<DynamicStyleJson>(resolve(baseDir, entry.path))
      const style = await createDynamicStyleFn(entry.name ?? id, json, {
        units: entry.options?.units,
        dotsPerInch: entry.options?.dotsPerInch
      })
      return {
        name: id,
        title: entry.title ?? json.title ?? titleFromId(id),
        abstract: entry.abstract,
        style
      }
    }
  }
}

function createLayers(
  layerEntries: LayerJson[],
  sources: Map<string, Source>,
  styles: Map<string, WmsLayerStyle>,
  crs: CrsRegistry
): WmsLayer[] {
  return layerEntries.map((entry) => {
    const source = sources.get(entry.source)
    if (!source) {
      throw new Error(`Unknown source "${entry.source}" in layer "${entry.name}"`)
    }

    const styleIds = entry.styles ?? (entry.style ? [entry.style] : [])
    if (styleIds.length === 0) {
      throw new Error(`Layer "${entry.name}" must reference at least one style`)
    }

    const layerStyles = styleIds.map((styleId) => {
      const style = styles.get(styleId)
      if (!style) {
        throw new Error(`Unknown style "${styleId}" in layer "${entry.name}"`)
      }

      return style
    })

    const layerCrs = entry.crs
      ? entry.crs.map((name) => crs.resolve(name) ?? name)
      : crs.codes()

    if (layerCrs.length === 0) {
      layerCrs.push(source.crs)
    }

    return {
      name: entry.name,
      title: entry.title,
      abstract: entry.abstract,
      source,
      crs: layerCrs,
      style: layerStyles[0].style,
      styles: layerStyles
    }
  })
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || id
}

class CrsRegistry {
  private readonly refs = new Map<string, CrsCode>()

  constructor(entries: Record<string, CrsJson> = {}) {
    for (const [name, entry] of Object.entries(entries)) {
      this.refs.set(name, entry.code)
      this.refs.set(entry.code, entry.code)

      if (entry.proj4) {
        proj4.defs(entry.code, entry.proj4)
      }

      for (const alias of entry.aliases ?? []) {
        this.refs.set(alias, entry.code)
      }
    }
  }

  resolve(name: string | undefined): CrsCode | undefined {
    if (!name) return undefined
    return this.refs.get(name) ?? name
  }

  codes(): CrsCode[] {
    return [...new Set(this.refs.values())]
  }
}
