import { readFile, writeFile } from 'node:fs/promises'
import Fill from 'ol/style/Fill.js'
import proj4 from 'proj4'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import type { BBox } from '../core/types.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import type { GeoGeometry } from '../geometry/geo-geometry.js'
import { renderGetMap } from '../ogc/render-get-map.js'
import { MemoryGeoSource } from '../source/memory-geo-source.js'
import type { StyleResolver } from '../style/style-resolver.js'

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

type GeoJsonFeature = {
  type: 'Feature'
  id?: string | number
  properties?: Record<string, unknown> | null
  bbox?: number[]
  geometry: GeoJsonGeometry | null
}

type GeoJsonGeometry =
  | { type: 'Point', coordinates: Position }
  | { type: 'LineString', coordinates: Position[] }
  | { type: 'Polygon', coordinates: Position[][] }
  | { type: 'MultiPoint', coordinates: Position[] }
  | { type: 'MultiLineString', coordinates: Position[][] }
  | { type: 'MultiPolygon', coordinates: Position[][][] }

type Position = [number, number, ...number[]]

const WEB_MERCATOR_MAX = 20037508.342789244
const WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
const WORLD_BBOX_3857: BBox = [
  -WEB_MERCATOR_MAX,
  -WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX
]

proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs +type=crs')
proj4.defs(
  'EPSG:3857',
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs'
)

const worldStyle = new Style({
  stroke: new Stroke({
    color: '#334155',
    width: 0.75
  }),
  fill: new Fill({
    color: 'rgba(56, 189, 248, 0.18)'
  })
})

const worldStyleResolver: StyleResolver = () => worldStyle

const geojson = JSON.parse(await readFile('data/world.geojson', 'utf8')) as GeoJsonFeatureCollection
const features = geojson.features.map(toGeoFeature)

const source = new MemoryGeoSource('world', 'EPSG:3857', features)
const image = await renderGetMap({
  source,
  bbox: WORLD_BBOX_3857,
  width: 500,
  height: 500,
  crs: 'EPSG:3857',
  styleResolver: worldStyleResolver
})

await writeFile('world.png', image)
console.log('world.png generated')

function toGeoFeature(feature: GeoJsonFeature, index: number): GeoFeature {
  return {
    id: feature.id ?? index,
    properties: feature.properties ?? {},
    bbox: toProjectedBBox(feature.bbox),
    geometry: toGeoGeometry(feature.geometry)
  }
}

function toProjectedBBox(bbox: number[] | undefined): BBox | undefined {
  if (!bbox || bbox.length < 4) return undefined

  const [minX, minY] = projectPosition([bbox[0], bbox[1]])
  const [maxX, maxY] = projectPosition([bbox[2], bbox[3]])

  return [minX, minY, maxX, maxY]
}

function toGeoGeometry(geometry: GeoJsonGeometry | null): GeoGeometry | null {
  if (!geometry) return null

  switch (geometry.type) {
    case 'Point':
      return {
        type: 'Point',
        coordinates: projectPosition(geometry.coordinates)
      }

    case 'LineString':
      return {
        type: 'LineString',
        coordinates: flattenPositions(geometry.coordinates)
      }

    case 'Polygon':
      return {
        type: 'Polygon',
        rings: geometry.coordinates.map(flattenPositions)
      }

    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: flattenPositions(geometry.coordinates)
      }

    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        lines: geometry.coordinates.map(flattenPositions)
      }

    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        polygons: geometry.coordinates.map((polygon) => polygon.map(flattenPositions))
      }
  }
}

function flattenPositions(positions: Position[]): Float64Array {
  const coordinates = new Float64Array(positions.length * 2)

  for (let i = 0; i < positions.length; i += 1) {
    const [x, y] = projectPosition(positions[i])
    coordinates[i * 2] = x
    coordinates[i * 2 + 1] = y
  }

  return coordinates
}

function projectPosition(position: Position): [number, number] {
  const longitude = position[0]
  const latitude = clamp(position[1], -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT)

  return proj4('EPSG:4326', 'EPSG:3857', [longitude, latitude]) as [number, number]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
