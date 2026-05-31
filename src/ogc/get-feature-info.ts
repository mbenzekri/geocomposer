import type { Feature, Props } from '../core/feature.js'
import type { BBox, CrsCode, HitContext, Position } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { Layer } from '../layer/layer.js'
import { escape } from '../core/tools.js'

export type FeatureInfoHit = {
  layerName: string
  feature: Feature
}

export type FeatureInfoResult = {
  crs: CrsCode
  bbox: BBox
  width: number
  height: number
  pixel: {
    i: number
    j: number
  }
  coordinate: Position
  hits: FeatureInfoHit[]
}

export type GetFeatureInfoOptions = {
  layers: Layer[]
  bbox: BBox
  width: number
  height: number
  crs: CrsCode
  i: number
  j: number
  featureCount: number
  tolerancePixels?: number
}

export async function getFeatureInfo(options: GetFeatureInfoOptions): Promise<FeatureInfoResult> {
  const point = pixelToCoordinate(options.bbox, options.width, options.height, options.i, options.j)
  const tolerancePixels = options.tolerancePixels ?? 4
  const toleranceX = ((options.bbox[2] - options.bbox[0]) / options.width) * tolerancePixels
  const toleranceY = ((options.bbox[3] - options.bbox[1]) / options.height) * tolerancePixels
  const context: HitContext = {
    point,
    bbox: [
      point[0] - toleranceX,
      point[1] - toleranceY,
      point[0] + toleranceX,
      point[1] + toleranceY
    ],
    tolerance: Math.max(toleranceX, toleranceY),
    toleranceX,
    toleranceY
  }
  const hits: FeatureInfoHit[] = []

  for (const layer of options.layers) {
    await collectLayerHits(layer, options.crs, context, options.featureCount, hits)

    if (hits.length >= options.featureCount) break
  }

  return {
    crs: options.crs,
    bbox: options.bbox,
    width: options.width,
    height: options.height,
    pixel: {
      i: options.i,
      j: options.j
    },
    coordinate: point,
    hits
  }
}

export function featureInfoToGeoJson(result: FeatureInfoResult): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: {
        name: result.crs
      }
    },
    queryPoint: {
      type: 'Point',
      coordinates: result.coordinate,
      crs: result.crs,
      pixel: result.pixel
    },
    numberReturned: result.hits.length,
    features: result.hits.map((hit) => toGeoJsonFeature(hit))
  })
}

export function featureInfoToXml(result: FeatureInfoResult): string {
  const layers = groupHitsByLayer(result.hits)
  const layerXml = [...layers.entries()].map(([layerName, hits]) => [
    `<Layer name="${escape(layerName)}">`,
    ...hits.map((hit) => featureToXml(hit.feature)),
    '</Layer>'
  ].join('')).join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<FeatureInfoResponse version="1.3.0" crs="${escape(result.crs)}" numberReturned="${result.hits.length}">`,
    `<QueryPoint i="${result.pixel.i}" j="${result.pixel.j}" x="${result.coordinate[0]}" y="${result.coordinate[1]}"/>`,
    layerXml,
    '</FeatureInfoResponse>'
  ].join('')
}

function pixelToCoordinate(bbox: BBox, width: number, height: number, i: number, j: number): Position {
  const resolutionX = (bbox[2] - bbox[0]) / width
  const resolutionY = (bbox[3] - bbox[1]) / height

  return [
    bbox[0] + (i + 0.5) * resolutionX,
    bbox[3] - (j + 0.5) * resolutionY
  ]
}

async function collectLayerHits(
  layer: Layer,
  targetCrs: CrsCode,
  context: HitContext,
  featureCount: number,
  hits: FeatureInfoHit[]
): Promise<void> {
  const features = layer.query({
    bbox: context.bbox,
    crs: targetCrs,
    layer
  })
  const reader = features.getReader()
  let done = false

  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        done = true
        break
      }

      if (Gt.featureHitsPoint(next.value, context)) {
        hits.push({
          layerName: layer.name,
          feature: next.value
        })
      }

      if (hits.length >= featureCount) break
    }
  } finally {
    if (!done) {
      await reader.cancel()
    }
    reader.releaseLock()
  }
}

function toGeoJsonFeature(hit: FeatureInfoHit): Record<string, unknown> {
  const feature: Record<string, unknown> = {
    type: 'Feature',
    layer: hit.layerName,
    properties: normalizeJsonValue(hit.feature.properties ?? {}),
    geometry: hit.feature.geometry
  }

  if (hit.feature.id !== undefined) feature.id = hit.feature.id
  if (hit.feature.bbox) feature.bbox = hit.feature.bbox

  return feature
}

function groupHitsByLayer(hits: FeatureInfoHit[]): Map<string, FeatureInfoHit[]> {
  const groups = new Map<string, FeatureInfoHit[]>()

  for (const hit of hits) {
    const group = groups.get(hit.layerName)
    if (group) {
      group.push(hit)
      continue
    }

    groups.set(hit.layerName, [hit])
  }

  return groups
}

function featureToXml(feature: Feature): string {
  const id = feature.id === undefined ? '' : ` id="${escape(String(feature.id))}"`
  return [
    `<Feature${id}>`,
    propertiesToXml(feature.properties),
    feature.geometry ? `<Geometry type="${escape(feature.geometry.type)}" encoding="GeoJSON">${escape(JSON.stringify(feature.geometry))}</Geometry>` : '',
    '</Feature>'
  ].join('')
}

function propertiesToXml(properties: Props | null): string {
  if (!properties) return '<Properties/>'

  const propertyXml = Object.entries(properties).map(([name, value]) => {
    if (value === null || value === undefined) {
      return `<Property name="${escape(name)}" nil="true"/>`
    }

    return `<Property name="${escape(name)}" type="${escape(propertyType(value))}">${escape(propertyValue(value))}</Property>`
  }).join('')

  return `<Properties>${propertyXml}</Properties>`
}

function propertyType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function propertyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? String(value)
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item))

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, normalizeJsonValue(entry)])
    )
  }

  return value
}
