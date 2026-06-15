import type { BBox } from '../../core/geometry.js'
import type { Feature } from '../../core/feature.js'
import { FeatureIdentity } from '../../core/feature-id.js'
import { Gt } from '../../core/geotools.js'
import type { Props } from '../../core/tools.js'

export type FeatureCollectionMetadata = {
  timeStamp: string
  links: Props[]
}

export class GeoJsonFeatureEncoder {
  constructor(private readonly properties?: string[]) {}

  collection(features: Feature[], metadata: FeatureCollectionMetadata): Props {
    const bbox = this.collectionBBox(features)
    const body: Props = {
      type: 'FeatureCollection',
      timeStamp: metadata.timeStamp,
      numberReturned: features.length,
      links: metadata.links,
      features: features.map((feature) => this.feature(feature))
    }

    if (bbox) body.bbox = bbox
    return body
  }

  feature(source: Feature): Props {
    const feature: Props = {
      type: 'Feature',
      properties: this.propertiesFor(source),
      geometry: source.geometry
    }
    const id = FeatureIdentity.fromFeature(source)

    if (id !== undefined) feature.id = id
    if (source.bbox) feature.bbox = source.bbox

    return feature
  }

  private propertiesFor(feature: Feature): Props | null {
    const properties = feature.properties
    if (properties === null) return null

    const selected = this.properties
      ? Object.fromEntries(this.properties.map((name) => [name, properties?.[name]]))
      : properties

    return this.normalizeJsonValue(selected) as Props
  }

  private collectionBBox(features: Feature[]): BBox | null {
    let bbox: BBox | null = null

    for (const feature of features) {
      const featureBBox = feature.bbox ?? Gt.bbox(feature.geometry)
      if (featureBBox) bbox = bbox ? Gt.expand(bbox, featureBBox) : featureBBox
    }

    return bbox
  }

  private normalizeJsonValue(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map((item) => this.normalizeJsonValue(item))

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, entry]) => [key, this.normalizeJsonValue(entry)])
      )
    }

    return value
  }
}
