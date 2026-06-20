import { resolve } from "node:path"
import { Singleton } from "../src/core/tools.js"
import { GeoComposer } from "../src/geo-composer.js"
import { Config } from "../src/config/config.js"
import { writeTestConfig } from "./test-temp.js"

export function copyAny(val: any): any {
    return JSON.parse(JSON.stringify(val))
}
export function writeConf(filename: string, conf: Record<string, unknown>) {
    return writeTestConfig(filename, conf)
}

export let config_base: Record<string, any> = {}
export let config_min: Record<string, any> = {}

export function init() {
    config_base = copyAny(conf_base_template)
    config_min = copyAny(conf_min_template)
    Singleton.delete(Config)
    GeoComposer.clear()
}
export const config_full_path = resolve('config/config.json')

export const conf_base_template = {
    "$schema": "../../config/config.schema.json",
    "server": {
        "port": "$i{GEOC_PORT|3000}",
        "logLevel": "LOG"
    },
    "services": {
        "wms": {
            "path": "/wms",
            "title": "GeoComposer WMS",
            "abstract": "Minimal WMS server backed by the GeoComposer render pipeline.",
            "onlineResource": "http://localhost:3000/wms",
            "maxWidth": 4096,
            "maxHeight": 4096
        }
    },
    "crs": {
        "EPSG:4326": {
            "title": "WGS84"
        },
        "EPSG:3857": {
            "title": "Web Mercator"
        }
    },
    "sources": {
        "world": {
            "type": "geojson",
            "title": "World GeoJSON",
            "abstract": "World country boundaries GeoJSON demo source.",
            "path": "../../data/world.geojson"
        }
    },
    "layers": {
        "world": {
            "title": "World GeoJSON",
            "abstract": "World country boundaries from the GeoJSON demo dataset.",
            "source": "world",
            "crs": "EPSG:4326",
            "extent": [ -180, -90, 180, 90 ],
            "style": "default",
            "pointProperties": [
                {
                    "x": "label_x",
                    "y": "label_y",
                    "crs": "EPSG:4326"
                }
            ]
        }
    }
}

export const conf_min_template = {
    server: { port: 3000, logLevel: "LOG" },
    services: { wms: { title: "WMS service" } },
    sources: { "world": { type: "geojson", path: "../../data/world.geojson" } },
    layers: { "world": { title: "World layer", source: "world", crs: "EPSG:4326" } },
    crs: { "EPSG:4326": { name: "WGS84", title: "WGS84 coordinate system" } },
    styles: { },
}

export const world_min_datasets = { "world": { "tableName": "world" } }

export const postgis_cnx_short = "postgres://postgres:$s{GEOC_PGPWD|postgres}@localhost:5432/postgres"
export const postgis_cnx_long = {
    "connectionString": postgis_cnx_short,
    "max": 4,
    "connectionTimeoutMillis": 5000,
    "idleTimeoutMillis": 30000,
    "statementTimeoutMillis": 30000,
    "applicationName": "geocomposer"
}

export const oracle_cnx_short = "oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1"
export const oracle_cnx_long = {
    "connectionString": oracle_cnx_short,
    "poolMin": 0,
    "poolMax": 4,
    "queueTimeout": 30000,
    "callTimeout": 30000
}
