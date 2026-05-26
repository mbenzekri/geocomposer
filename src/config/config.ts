import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { BBox, CrsCode } from '../core/types.js'
import { Layer, type LayerStyle } from '../layer/layer.js'
import { XyzLayer } from '../layer/xyz-layer.js'
import type { WmsInfo, WmsOptions } from '../service/wms.js'
import { GeoJsonSource } from '../source/geojson-source.js'
import { GmlSource, type GmlAxisOrder } from '../source/gml-source.js'
import { GpkgSource } from '../source/gpkg-source.js'
import { MemSource } from '../source/mem-source.js'
import { ShpSource } from '../source/shp-source.js'
import type { Source } from '../source/source.js'
import { createDynamicStyleFn, type DynamicStyleJson } from '../style/dynamic-style.js'
import { defaultStyleFn } from '../style/default-style.js'
import type { StyleFn } from '../style/style-fn.js'
import type { XyzOptions } from '../service/xyz.js'

export type CrsJson = {
  name: CrsCode
  title: string
}

export type GeoJsonSourceJson = {
  type: 'geojson'
  name: string
  title?: string
  abstract?: string
  crs?: string
  path: string
  encoding?: BufferEncoding
  highWaterMark?: number
}

export type GmlSourceJson = {
  type: 'gml'
  name: string
  title?: string
  abstract?: string
  crs?: string
  path: string
  encoding?: BufferEncoding
  highWaterMark?: number
  featureElementNames?: string[]
  geometryPropertyNames?: string[]
  axisOrder?: GmlAxisOrder
}

export type ShpSourceJson = {
  type: 'shp'
  name: string
  title?: string
  abstract?: string
  crs?: string
  shpPath: string
  dbfPath: string
  dbfEncoding?: BufferEncoding
  highWaterMark?: number
}

export type GpkgSourceJson = {
  type: 'gpkg'
  name: string
  title?: string
  abstract?: string
  crs?: string
  path: string
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
}

export type MemSourceJson = {
  type: 'mem'
  name: string
  title?: string
  abstract?: string
  source: string
}

export type SourceJson =
  | GeoJsonSourceJson
  | GmlSourceJson
  | ShpSourceJson
  | GpkgSourceJson
  | MemSourceJson

export type BuiltinStyleJson = {
  type: 'builtin'
  name: 'default'
  title?: string
  abstract?: string
}

export type DynamicStyleOptionsJson = {
  units?: 'm' | 'dd'
  dotsPerInch?: number
}

export type DynamicStyleFileJson = {
  type: 'dynamic'
  name: string
  title?: string
  abstract?: string
  path: string
  options?: DynamicStyleOptionsJson
}

export type StyleJson = BuiltinStyleJson | DynamicStyleFileJson

export type LayerJson = {
  name: string
  title?: string
  abstract?: string
  source: string
  sourceCrs?: string
  extent?: BBox
  style?: string
  styles?: string[]
}

export type ServerJson = {
  port?: number
  path?: string
  maxWidth?: number
  maxHeight?: number
}

export type XyzLayerRefJson = {
  layer: string
  style?: string
}

export type XyzLayerJson = {
  name: string
  title?: string
  abstract?: string
  layer?: string
  style?: string
  layers?: XyzLayerRefJson[]
}

export type XyzJson = {
  path?: string
  tileSize?: number
  minZoom?: number
  maxZoom?: number
  maxScaleFactor?: number
  cacheControl?: string
  cache?: string
  layers?: XyzLayerJson[]
}

export type GeoComposerJson = {
  server?: ServerJson
  service: WmsInfo
  xyz?: XyzJson
  crs?: CrsJson[]
  sources: SourceJson[]
  styles?: StyleJson[]
  layers: LayerJson[]
}

export type LoadedConfig = {
  path: string
  dir: string
  server: Required<ServerJson>
  wms: WmsOptions
  xyz?: XyzOptions
}

const BUILTIN_STYLES: Record<BuiltinStyleJson['name'], StyleFn> = {
  default: defaultStyleFn
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const path = resolve(configPath)
  const dir = dirname(path)
  const config = await readJsonFile<GeoComposerJson>(path)
  const crs = new CrsRegistry(config.crs)
  const sources = createSources(config.sources, dir, crs)
  const styles = await createStyles(config.styles ?? [], dir)
  const layers = createLayers(config.layers, sources, styles, crs)
  const xyz = config.xyz ? createXyzOptions(config.xyz, layers, dir) : undefined
  const wmsCrs = crs.codes()

  return {
    path,
    dir,
    server: {
      port: config.server?.port ?? 3000,
      path: config.server?.path ?? '/wms',
      maxWidth: config.server?.maxWidth ?? 4096,
      maxHeight: config.server?.maxHeight ?? 4096
    },
    wms: {
      path: config.server?.path ?? '/wms',
      maxWidth: config.server?.maxWidth ?? 4096,
      maxHeight: config.server?.maxHeight ?? 4096,
      info: config.service,
      ...(wmsCrs.length > 0 ? { crs: wmsCrs } : {}),
      layers
    },
    ...(xyz ? { xyz } : {})
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
  sourceEntries: SourceJson[],
  baseDir: string,
  crs: CrsRegistry
): Map<string, Source> {
  const sourceEntriesByName = new Map<string, SourceJson>()
  const sources = new Map<string, Source>()
  const creating = new Set<string>()

  for (const entry of sourceEntries) {
    if (sourceEntriesByName.has(entry.name)) {
      throw new Error(`Duplicate source "${entry.name}"`)
    }

    sourceEntriesByName.set(entry.name, entry)
  }

  const resolveSource = (name: string): Source => {
    const existing = sources.get(name)
    if (existing) return existing

    const entry = sourceEntriesByName.get(name)
    if (!entry) {
      throw new Error(`Unknown source "${name}"`)
    }

    if (creating.has(name)) {
      throw new Error(`Circular source reference involving "${name}"`)
    }

    creating.add(name)
    try {
      const source = createSource(entry, baseDir, crs, resolveSource)
      sources.set(name, source)
      return source
    } finally {
      creating.delete(name)
    }
  }

  for (const entry of sourceEntries) {
    resolveSource(entry.name)
  }

  return sources
}

function createSource(
  entry: SourceJson,
  baseDir: string,
  crs: CrsRegistry,
  resolveSource: (name: string) => Source
): Source {
  switch (entry.type) {
    case 'geojson':
      return new GeoJsonSource(entry.name, resolve(baseDir, entry.path), {
        crs: crs.resolve(entry.crs),
        encoding: entry.encoding,
        highWaterMark: entry.highWaterMark
      })

    case 'gml':
      return new GmlSource(entry.name, resolve(baseDir, entry.path), {
        crs: crs.resolve(entry.crs),
        encoding: entry.encoding,
        highWaterMark: entry.highWaterMark,
        featureElementNames: entry.featureElementNames,
        geometryPropertyNames: entry.geometryPropertyNames,
        axisOrder: entry.axisOrder
      })

    case 'shp':
      return new ShpSource(
        entry.name,
        resolve(baseDir, entry.shpPath),
        resolve(baseDir, entry.dbfPath),
        {
          crs: crs.resolve(entry.crs),
          dbfEncoding: entry.dbfEncoding,
          highWaterMark: entry.highWaterMark
        }
      )

    case 'gpkg':
      return new GpkgSource(entry.name, resolve(baseDir, entry.path), {
        crs: crs.resolve(entry.crs),
        tableName: entry.tableName,
        geometryColumn: entry.geometryColumn,
        primaryKey: entry.primaryKey
      })

    case 'mem':
      return new MemSource(entry.name, resolveSource(entry.source))
  }
}

async function createStyles(
  styleEntries: StyleJson[],
  baseDir: string
): Promise<Map<string, LayerStyle>> {
  const styles = new Map<string, LayerStyle>([
    [
      'default',
      {
        name: 'default',
        title: 'Default',
        style: defaultStyleFn
      }
    ]
  ])

  for (const entry of styleEntries) {
    styles.set(entry.name, await createStyle(entry, baseDir))
  }

  return styles
}

async function createStyle(entry: StyleJson, baseDir: string): Promise<LayerStyle> {
  switch (entry.type) {
    case 'builtin':
      return {
        name: entry.name,
        title: entry.title ?? titleFromId(entry.name),
        summary: entry.abstract,
        style: BUILTIN_STYLES[entry.name]
      }

    case 'dynamic': {
      const json = await readJsonFile<DynamicStyleJson>(resolve(baseDir, entry.path))
      const style = await createDynamicStyleFn(entry.name, json, {
        units: entry.options?.units,
        dotsPerInch: entry.options?.dotsPerInch
      })
      return {
        name: entry.name,
        title: entry.title ?? json.title ?? titleFromId(entry.name),
        summary: entry.abstract,
        style
      }
    }
  }
}

function createLayers(
  layerEntries: LayerJson[],
  sources: Map<string, Source>,
  styles: Map<string, LayerStyle>,
  crs: CrsRegistry
): Layer[] {
  return layerEntries.map((entry) => {
    const source = sources.get(entry.source)
    if (!source) {
      throw new Error(`Unknown source "${entry.source}" in layer "${entry.name}"`)
    }

    const defaultStyleId = entry.style ?? entry.styles?.[0] ?? 'default'
    const styleIds = unique([defaultStyleId, ...(entry.styles ?? [])])

    const layerStyles = styleIds.map((styleId) => {
      const style = styles.get(styleId)
      if (!style) {
        throw new Error(`Unknown style "${styleId}" in layer "${entry.name}"`)
      }

      return style
    })
    const sourceCrs = normalizeSourceCrs(entry.sourceCrs, source, entry.name, crs)

    return new Layer(entry.name, {
      title: entry.title,
      summary: entry.abstract,
      source,
      sourceCrs,
      extent: normalizeExtent(entry.extent, entry.name),
      styles: layerStyles
    })
  })
}

function createXyzOptions(
  xyz: XyzJson,
  mapLayers: Layer[],
  baseDir: string
): XyzOptions {
  const layersByName = new Map(mapLayers.map((layer) => [layer.name, layer]))
  const xyzLayers = (xyz.layers && xyz.layers.length > 0
    ? xyz.layers
    : mapLayers.map((layer) => ({
      name: layer.name,
      title: layer.title,
      abstract: layer.summary,
      layer: layer.name
    }))
  ).map((entry) => createXyzLayer(entry, layersByName))

  return {
    path: xyz.path,
    tileSize: xyz.tileSize,
    minZoom: xyz.minZoom,
    maxZoom: xyz.maxZoom,
    maxScaleFactor: xyz.maxScaleFactor,
    cacheControl: xyz.cacheControl,
    cache: xyz.cache ? resolve(baseDir, xyz.cache) : undefined,
    layers: xyzLayers
  }
}

function createXyzLayer(
  entry: XyzLayerJson,
  layersByName: Map<string, Layer>
): XyzLayer {
  const layerRefs = normalizeXyzLayerRefs(entry)
  if (layerRefs.length === 0) {
    throw new Error(`XYZ layer "${entry.name}" must reference at least one configured layer`)
  }

  return new XyzLayer(entry.name, {
    title: entry.title,
    summary: entry.abstract,
    layers: layerRefs.map((ref) => {
      const layer = layersByName.get(ref.layer)
      if (!layer) {
        throw new Error(`Unknown layer "${ref.layer}" in XYZ layer "${entry.name}"`)
      }

      return {
        source: layer.source,
        style: resolveConfiguredLayerStyle(layer, ref.style, entry.name)
      }
    })
  })
}

function normalizeXyzLayerRefs(entry: XyzLayerJson): XyzLayerRefJson[] {
  if (entry.layers && entry.layers.length > 0) {
    return entry.layers.map((ref) => ({
      layer: ref.layer,
      style: ref.style
    }))
  }

  if (!entry.layer) {
    throw new Error(`XYZ layer "${entry.name}" must define "layer" or "layers"`)
  }

  return [{
    layer: entry.layer,
    style: entry.style
  }]
}

function resolveConfiguredLayerStyle(
  layer: Layer,
  styleName: string | undefined,
  xyzLayerName: string
): StyleFn {
  try {
    return layer.resolveStyle(styleName)
  } catch (error) {
    if (!styleName) throw error
    throw new Error(`Unknown style "${styleName}" for layer "${layer.name}" in XYZ layer "${xyzLayerName}"`)
  }
}

function normalizeSourceCrs(
  sourceCrs: string | undefined,
  source: Source,
  layerName: string,
  crs: CrsRegistry
): CrsCode {
  const resolved = crs.resolve(sourceCrs) ?? source.crs

  if (resolved !== source.crs) {
    throw new Error(`Layer "${layerName}" sourceCrs "${resolved}" does not match source "${source.id}" CRS "${source.crs}"`)
  }

  return resolved
}

function normalizeExtent(extent: BBox | undefined, layerName: string): BBox | undefined {
  if (extent === undefined) return undefined

  if (!Array.isArray(extent) || extent.length !== 4 || extent.some((value) => !Number.isFinite(value))) {
    throw new Error(`Layer "${layerName}" extent must be a bbox [minx,miny,maxx,maxy]`)
  }

  const bbox: BBox = [extent[0], extent[1], extent[2], extent[3]]
  if (!(bbox[0] < bbox[2]) || !(bbox[1] < bbox[3])) {
    throw new Error(`Layer "${layerName}" extent bbox minimum bounds must be lower than maximum bounds`)
  }

  return bbox
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || id
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

class CrsRegistry {
  private readonly refs = new Map<string, CrsCode>()

  constructor(entries: CrsJson[] = []) {
    for (const entry of entries) {
      this.refs.set(entry.name, entry.name)
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
