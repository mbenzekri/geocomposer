import type { BBox, CrsCode, Props } from '../core/types.js'
import { Geom } from '../geometry/geom.js'
import type { Feature } from '../geometry/feature.js'
import type { Geometry, Position } from '../geometry/geometry.js'
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

type HitContext = {
  point: Position
  bbox: BBox
  tolerance: number
  toleranceX: number
  toleranceY: number
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
    crs: targetCrs
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

      if (featureHitsPoint(next.value, context)) {
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

function featureHitsPoint(feature: Feature, context: HitContext): boolean {
  if (!feature.geometry) return false

  const bbox = feature.bbox ?? Geom.bbox(feature.geometry)
  if (bbox && !Geom.intersects(bbox, context.bbox)) return false

  return geometryHitsPoint(feature.geometry, context)
}

function geometryHitsPoint(geometry: Geometry, context: HitContext): boolean {
  switch (geometry.type) {
    case 'Point':
      return positionHitsPoint(geometry.coordinates, context)

    case 'MultiPoint':
      return geometry.coordinates.some((position) => positionHitsPoint(position, context))

    case 'LineString':
      return lineHitsPoint(geometry.coordinates, context)

    case 'MultiLineString':
      return geometry.coordinates.some((line) => lineHitsPoint(line, context))

    case 'Polygon':
      return polygonHitsPoint(geometry.coordinates, context)

    case 'MultiPolygon':
      return geometry.coordinates.some((polygon) => polygonHitsPoint(polygon, context))
  }
}

function positionHitsPoint(position: Position, context: HitContext): boolean {
  return Math.abs(position[0] - context.point[0]) <= context.toleranceX
    && Math.abs(position[1] - context.point[1]) <= context.toleranceY
}

function lineHitsPoint(line: Position[], context: HitContext): boolean {
  if (line.length === 0) return false
  if (line.length === 1) return positionHitsPoint(line[0], context)

  for (let index = 1; index < line.length; index += 1) {
    if (distanceToSegment(context.point, line[index - 1], line[index]) <= context.tolerance) {
      return true
    }
  }

  return false
}

function polygonHitsPoint(polygon: Position[][], context: HitContext): boolean {
  if (polygon.length === 0) return false

  if (lineHitsPoint(polygon[0], context)) return true
  if (!pointInRing(context.point, polygon[0])) return false

  for (const hole of polygon.slice(1)) {
    if (lineHitsPoint(hole, context)) return true
    if (pointInRing(context.point, hole)) return false
  }

  return true
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPosition = ring[index]
    const previousPosition = ring[previous]
    const intersects = (currentPosition[1] > point[1]) !== (previousPosition[1] > point[1])
      && point[0] < ((previousPosition[0] - currentPosition[0]) * (point[1] - currentPosition[1]))
        / (previousPosition[1] - currentPosition[1]) + currentPosition[0]

    if (intersects) inside = !inside
  }

  return inside
}

function distanceToSegment(point: Position, start: Position, end: Position): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]

  if (dx === 0 && dy === 0) {
    return distance(point, start)
  }

  const t = clamp(
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy),
    0,
    1
  )
  const projected: Position = [
    start[0] + t * dx,
    start[1] + t * dy
  ]

  return distance(point, projected)
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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
