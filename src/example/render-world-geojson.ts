import { mkdir, rm, writeFile } from 'node:fs/promises'
import Fill from 'ol/style/Fill.js'
import proj4 from 'proj4'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import type { BBox } from '../core/types.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import type { GeoGeometry, GeoPosition } from '../geometry/geo-geometry.js'
import { renderGetMap } from '../ogc/render-get-map.js'
import { GeoJsonGeoSource } from '../source/geojson-geo-source.js'
import type { StyleResolver } from '../style/style-resolver.js'

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

await rm('style-smoke/world.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new GeoJsonGeoSource('world', 'data/world.geojson', {
  crs: 'EPSG:3857',
  transformFeature: toProjectedFeature
})

await source.open()
try {
  const image = await renderGetMap({
    source,
    bbox: WORLD_BBOX_3857,
    width: 500,
    height: 500,
    crs: 'EPSG:3857',
    styleResolver: worldStyleResolver
  })

  await writeFile('style-smoke/world.png', image)
} finally {
  await source.close()
}

console.log('style-smoke/world.png generated')

function toProjectedFeature(feature: GeoFeature, index: number): GeoFeature {
  return {
    type: 'Feature',
    id: feature.id ?? index,
    properties: feature.properties ?? {},
    geometry: projectGeometry(feature.geometry)
  }
}

function projectGeometry(geometry: GeoGeometry | null): GeoGeometry | null {
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
        coordinates: geometry.coordinates.map(projectPosition)
      }

    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) => ring.map(projectPosition))
      }

    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: geometry.coordinates.map(projectPosition)
      }

    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line) => line.map(projectPosition))
      }

    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(projectPosition))
        )
      }
  }
}

function projectPosition(position: GeoPosition): GeoPosition {
  const longitude = position[0]
  const latitude = clamp(position[1], -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT)
  const [x, y] = proj4('EPSG:4326', 'EPSG:3857', [longitude, latitude]) as [number, number]

  return position.length > 2 ? [x, y, ...position.slice(2)] : [x, y]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
