import type { BBox, CrsCode } from '../core/geometry.js'
import type { Feature } from '../core/feature.js'
import type { QueryOptions, Source, StreamOptions } from '../source/source.js'
import type { StyleFn } from '../style/style-fn.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import { Reproject } from '../stream/reproject.js'

export type NamedStyle = {
  name: string
  title?: string
  summary?: string
  style: StyleFn
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

    const input = this.source.query({
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
