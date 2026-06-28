import type { CsvSourceJson } from './csv-source.js'
import type { GeoJsonSourceJson } from './geojson-source.js'
import type { GmlSourceJson } from './gml-source.js'
import type { GpkgSourceJson } from './gpkg-source.js'
import type { MssqlSourceJson } from './mssql-source.js'
import type { OracleSourceJson } from './oracle-source.js'
import type { PostgisSourceJson } from './postgis-source.js'
import type { ShpSourceJson } from './shp-source.js'

export type SourceJson =
  | CsvSourceJson
  | GeoJsonSourceJson
  | GmlSourceJson
  | ShpSourceJson
  | GpkgSourceJson
  | PostgisSourceJson
  | MssqlSourceJson
  | OracleSourceJson
