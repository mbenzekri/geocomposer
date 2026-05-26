import type { RenderLayer } from '../ogc/render-map.js'

export type XyzLayerOptions = {
  title?: string
  summary?: string
  layers: RenderLayer[]
}

export class XyzLayer {
  readonly title?: string
  readonly summary?: string
  readonly layers: RenderLayer[]

  constructor(
    readonly name: string,
    options: XyzLayerOptions
  ) {
    if (options.layers.length === 0) {
      throw new Error(`XYZ layer "${name}" must reference at least one layer`)
    }

    this.title = options.title
    this.summary = options.summary
    this.layers = options.layers
  }
}
