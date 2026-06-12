import type { BBox, CrsCode } from '../core/geometry.js'
import type { Feature } from '../core/feature.js'
import type { QueryOptions, Source, StreamOptions } from '../source/source.js'
import type { StyleFn } from '../style/style-fn.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import { Reproject } from '../stream/reproject.js'
import { Gt } from '../core/geotools.js'
import type { Dict } from '../core/tools.js'
import type { LayerJson } from '../config/config.js'

export type NamedStyle = {
  readonly name: string
  readonly title?: string
  readonly abstract?: string
  readonly style: StyleFn
}
export type PointProperties = {
  x: string
  y: string
  crs: CrsCode
}

export type LayerOptions = {
  title?: string
  summary?: string
  source: Source
  sourceCrs?: CrsCode
  extent?: BBox
  styles: NamedStyle[]
  pointProperties: PointProperties[]
}

export type LayerStreamOptions = Omit<StreamOptions, 'layer'>
export type LayerQueryOptions = Omit<QueryOptions, 'layer'>

type LayerCrsResolver = {
  resolve(name: string | undefined): CrsCode | undefined
}

export class Layer {
  readonly title?: string
  readonly summary?: string
  readonly source: Source
  readonly sourceCrs: CrsCode
  readonly extent?: BBox
  readonly styles: readonly NamedStyle[]
  readonly pointProperties: PointProperties[]

  constructor(
    readonly name: string,
    options: LayerOptions
  ) {
    if (options.styles.length === 0) {
      throw new Error(`Layer "${name}" must define at least one style`)
    }

    this.title = options.title
    this.summary = options.summary
    this.source = options.source
    this.sourceCrs = options.sourceCrs ?? options.source.crs
    this.extent = options.extent
    this.styles = options.styles
    this.pointProperties = options.pointProperties
  }

  static createAll(
    layerEntries: Dict<LayerJson>,
    sources: Map<string, Source>,
    styles: Map<string, NamedStyle>,
    crs: LayerCrsResolver
  ): Layer[] {
    return Object.entries(layerEntries).map(([name, entry]) => Layer.create(name, entry, sources, styles, crs))
  }

  static create(
    name: string,
    entry: LayerJson,
    sources: Map<string, Source>,
    styles: Map<string, NamedStyle>,
    crs: LayerCrsResolver
  ): Layer {
    const source = sources.get(entry.source)
    if (!source) {
      throw new Error(`Unknown source "${entry.source}" in layer "${name}"`)
    }

    const defaultStyleId = entry.style ?? entry.styles?.[0] ?? 'default'
    const styleIds = unique([defaultStyleId, ...(entry.styles ?? [])])
    const layerStyles = styleIds.map((styleId) => {
      const style = styles.get(styleId)
      if (!style) {
        throw new Error(`Unknown style "${styleId}" in layer "${name}"`)
      }

      return style
    })

    const sourceCrs = normalizeSourceCrs(entry.sourceCrs, source, name, crs)
    const pointProperties: PointProperties[] = []
    for (const pp of entry.pointProperties ?? []) {
      if (pp.x === pp.y) {
        throw new Error(`Layer "${name}" pointProperties must use different x and y properties`)
      }

      pointProperties.push({
        x: pp.x,
        y: pp.y,
        crs: normalizeSourceCrs(pp.crs, source, name, crs)
      })
    }

    return new Layer(name, {
      title: entry.title,
      summary: entry.abstract,
      source,
      sourceCrs,
      extent: Gt.normalize(entry.extent, name),
      styles: layerStyles,
      pointProperties
    })
  }

  get style(): StyleFn {
    return this.styles[0].style
  }

  async getExtent(): Promise<BBox | null> {
    return this.extent ?? await this.source.getExtent(this)
  }

  stream(options: LayerStreamOptions = {}): ReadableStream<Feature> {
    return this.source.stream({ ...options, layer: this })
  }

  query(options: LayerQueryOptions = {}): ReadableStream<Feature> {
    const crs = options.crs ?? this.sourceCrs

    if (crs === this.sourceCrs) {
      return this.source.query({
        bbox: options.bbox,
        signal: options.signal,
        properties: options.properties,
        layer: this
      })
    }

    const sourceBbox = options.bbox
      ? Gt.transformBBox(options.bbox, crs, this.sourceCrs)
      : undefined
    const input = this.source.query({
      bbox: sourceBbox,
      signal: options.signal,
      properties: options.properties,
      layer: this
    })

    const reprojected = input.pipeThrough(new Reproject(this.sourceCrs, crs))
    return options.bbox
      ? reprojected.pipeThrough(new BboxFilter(options.bbox))
      : reprojected
  }

  resolveStyle(name: string | undefined): StyleFn {
    if (!name) return this.style

    const style = this.styles.find((entry) => entry.name === name)
    if (!style) {
      throw new Error(`Unknown style "${name}" for layer "${this.name}"`)
    }

    return style.style
  }
}

function normalizeSourceCrs(
  sourceCrs: string | undefined,
  source: Source,
  layerName: string,
  crs: LayerCrsResolver
): CrsCode {
  const resolved = crs.resolve(sourceCrs) ?? source.crs

  if (resolved !== source.crs) {
    throw new Error(`Layer "${layerName}" sourceCrs "${resolved}" does not match source "${source.id}" CRS "${source.crs}"`)
  }

  return resolved
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
