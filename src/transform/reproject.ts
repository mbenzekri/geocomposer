import proj4 from 'proj4'
import { Geom } from '../core/geo-tools.js'
import type { Feature } from '../core/feature.js'
import type { Geometry, Position } from '../core/geometry.js'

const WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066

export class Reproject extends TransformStream<Feature, Feature> {
  constructor(
    sourceCrs: string,
    targetCrs: string
  ) {
    super({
      transform: (feature, controller) => {
        if (sourceCrs === targetCrs || !feature.geometry) {
          controller.enqueue(feature)
          return
        }

        const geometry = transformGeometry(feature.geometry, sourceCrs, targetCrs)
        const bbox = Geom.bbox(geometry) ?? undefined
        const properties = transformLabelPosition(feature.properties, sourceCrs, targetCrs)

        controller.enqueue({
          ...feature,
          geometry,
          bbox,
          properties
        })
      }
    })
  }
}

function transformLabelPosition(
  properties: Feature['properties'],
  sourceCrs: string,
  targetCrs: string
): Feature['properties'] {
  if (!properties) return properties

  const labelX = Number(properties.label_x)
  const labelY = Number(properties.label_y)
  if (!Number.isFinite(labelX) || !Number.isFinite(labelY)) return properties

  const [x, y] = transformPosition([labelX, labelY], sourceCrs, targetCrs)
  return {
    ...properties,
    label_x: x,
    label_y: y
  }
}

function transformGeometry(geometry: Geometry, sourceCrs: string, targetCrs: string): Geometry {
  switch (geometry.type) {
    case 'Point':
      return {
        type: 'Point',
        coordinates: transformPosition(geometry.coordinates, sourceCrs, targetCrs)
      }

    case 'LineString':
      return {
        type: 'LineString',
        coordinates: geometry.coordinates.map((position) =>
          transformPosition(position, sourceCrs, targetCrs)
        )
      }

    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) =>
          ring.map((position) => transformPosition(position, sourceCrs, targetCrs))
        )
      }

    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: geometry.coordinates.map((position) =>
          transformPosition(position, sourceCrs, targetCrs)
        )
      }

    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line) =>
          line.map((position) => transformPosition(position, sourceCrs, targetCrs))
        )
      }

    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) =>
            ring.map((position) => transformPosition(position, sourceCrs, targetCrs))
          )
        )
      }
  }
}

function transformPosition(position: Position, sourceCrs: string, targetCrs: string): Position {
  const x = position[0]
  const y = position[1]
  const [fromX, fromY] = sourceCrs === 'EPSG:4326' && targetCrs === 'EPSG:3857'
    ? [x, clamp(y, -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT)]
    : [x, y]

  let projected: [number, number]

  try {
    projected = proj4(sourceCrs, targetCrs, [fromX, fromY]) as [number, number]
  } catch (error) {
    throw new Error(`Unable to transform coordinates from ${sourceCrs} to ${targetCrs}: ${String(error)}`)
  }

  return position.length > 2 ? [projected[0], projected[1], ...position.slice(2)] : projected
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
