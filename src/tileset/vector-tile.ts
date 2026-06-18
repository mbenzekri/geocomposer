import type { Feature } from '../core/feature.js'
import type { BBox, CrsCode, Geometry } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { GEOJSON_TILE_FORMAT, MVT_TILE_FORMAT, type RequiredVectorTileOptions } from './tileset.js'
import { MvtEncoder } from './mvt-encoder.js'
import { VectorTileGeometryProcessor } from './vector-tile-geometry.js'

export type GetVectorTileOptions = {
  layers: Layer[]
  bbox: BBox
  crs: CrsCode
  tileSize: number
  format: string
  vector: RequiredVectorTileOptions
}

type GeoJsonTileFeature = {
  type: 'Feature'
  id?: string | number
  layer: string
  properties: Feature['properties']
  geometry: Geometry
}

type GeoJsonTileFeatureCollection = {
  type: 'FeatureCollection'
  crs: {
    type: 'name'
    properties: {
      name: string
    }
  }
  features: GeoJsonTileFeature[]
}

type EncodedLayerFeature = {
  id?: string | number
  properties: Feature['properties']
  geometry: Geometry
}

type EncodedLayer = {
  name: string
  extent: number
  features: EncodedLayerFeature[]
}

export async function getVectorTile(options: GetVectorTileOptions): Promise<Buffer> {
  return new VectorTileRenderer(options).render()
}

class VectorTileRenderer {
  private readonly processor: VectorTileGeometryProcessor
  private readonly geoJsonFeatures: GeoJsonTileFeature[] = []
  private readonly mvtLayers = new Map<string, EncodedLayer>()
  private featureCount = 0

  constructor(private readonly options: GetVectorTileOptions) {
    this.processor = new VectorTileGeometryProcessor({
      bbox: options.bbox,
      extent: options.vector.extent,
      buffer: options.vector.buffer,
      tolerance: options.vector.generalization.tolerance,
      tileSize: options.tileSize,
      precision: options.vector.geojsonPrecision
    })
  }

  async render(): Promise<Buffer> {
    for (const layer of this.options.layers) {
      await this.collectLayer(layer)
    }

    if (this.options.format === GEOJSON_TILE_FORMAT) {
      return Buffer.from(JSON.stringify(this.toGeoJson()), 'utf8')
    }

    if (this.options.format === MVT_TILE_FORMAT) {
      return new MvtEncoder().encode([...this.mvtLayers.values()])
    }

    throw new Error(`Unsupported vector tile format "${this.options.format}"`)
  }

  private async collectLayer(layer: Layer): Promise<void> {
    const stream = layer.query({
      bbox: this.processor.queryBbox,
      crs: this.options.crs
    })
    const reader = stream.getReader()

    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        this.collectFeature(layer, next.value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private collectFeature(layer: Layer, feature: Feature): void {
    const processed = this.processor.process(feature.geometry)
    if (!processed) return

    this.featureCount += 1
    if (this.options.vector.maxFeatures !== undefined && this.featureCount > this.options.vector.maxFeatures) {
      throw new Error(`Vector tile exceeds maxFeatures ${this.options.vector.maxFeatures}`)
    }

    this.geoJsonFeatures.push({
      type: 'Feature',
      id: feature.id,
      layer: layer.id,
      properties: cloneProperties(feature.properties),
      geometry: processed.worldGeometry
    })

    const mvtLayer = this.mvtLayer(layer.id)
    mvtLayer.features.push({
      id: feature.id,
      properties: cloneProperties(feature.properties),
      geometry: processed.tileGeometry
    })
  }

  private mvtLayer(name: string): EncodedLayer {
    const existing = this.mvtLayers.get(name)
    if (existing) return existing

    const layer: EncodedLayer = {
      name,
      extent: this.options.vector.extent,
      features: []
    }
    this.mvtLayers.set(name, layer)
    return layer
  }

  private toGeoJson(): GeoJsonTileFeatureCollection {
    return {
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: {
          name: this.options.crs
        }
      },
      features: this.geoJsonFeatures
    }
  }
}

function cloneProperties(properties: Feature['properties']): Feature['properties'] {
  return properties ? { ...properties } : null
}
