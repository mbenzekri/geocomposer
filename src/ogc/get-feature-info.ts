import type { Feature, Props } from '../core/feature.js'
import { createHitContext, pixelToCoordinate, type BBox, type CrsCode, type HitContext, type Position } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { escape } from '../core/tools.js'
import { HitFilter } from '../transform/hit-filter.js'

export type Hit = {
    layerName: string
    feature: Feature
}

export type InfoResult = {
    crs: CrsCode
    bbox: BBox
    width: number
    height: number
    pixel: {
        i: number
        j: number
    }
    coordinate: Position
    hits: Hit[]
}

export type GetInfoOptions = {
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

export async function getInfo(options: GetInfoOptions): Promise<InfoResult> {
    const point = pixelToCoordinate(options.bbox, options.width, options.height, options.i, options.j)
    const tolerancePixels = options.tolerancePixels ?? 4
    const context = createHitContext(tolerancePixels,options.bbox, options.width,options.height, point)
    const hits: Hit[] = []

    for (const layer of options.layers) {
        const layerHits = layer.query({
            bbox: context.bbox,
            crs: options.crs
        }).pipeThrough(new HitFilter(layer.name, context))

        await collectHits(layerHits, options.featureCount - hits.length, hits)

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

export abstract class InfoFormatter {
    abstract format(result: InfoResult): string
}

export class GeoJsonFormatter extends InfoFormatter {
    format(result: InfoResult): string {
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
            features: result.hits.map((hit) => this.toGeoJsonFeature(hit))
        })
    }
    private toGeoJsonFeature(hit: Hit): Record<string, unknown> {
        const feature: Record<string, unknown> = {
            type: 'Feature',
            layer: hit.layerName,
            properties: this.normalizeJsonValue(hit.feature.properties ?? {}),
            geometry: hit.feature.geometry
        }

        if (hit.feature.id !== undefined) feature.id = hit.feature.id
        if (hit.feature.bbox) feature.bbox = hit.feature.bbox

        return feature
    }

    private normalizeJsonValue(value: unknown): unknown {
        if (typeof value === 'bigint') return value.toString()
        if (Array.isArray(value)) return value.map((item) => this.normalizeJsonValue(item))

        if (typeof value === 'object' && value !== null) {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .map(([key, entry]) => [key, this.normalizeJsonValue(entry)])
            )
        }

        return value
    }

}

export class XmlFormatter extends InfoFormatter {
    format(result: InfoResult): string {
        const layers = groupHitsByLayer(result.hits)
        const layerXml = [...layers.entries()].map(([layerName, hits]) => [
            `<Layer name="${escape(layerName)}">`,
            ...hits.map((hit) => this.featureToXml(hit.feature)),
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

    private featureToXml(feature: Feature): string {
        const id = feature.id === undefined ? '' : ` id="${escape(String(feature.id))}"`
        return [
            `<Feature${id}>`,
            this.propertiesToXml(feature.properties),
            feature.geometry ? `<Geometry type="${escape(feature.geometry.type)}" encoding="GeoJSON">${escape(JSON.stringify(feature.geometry))}</Geometry>` : '',
            '</Feature>'
        ].join('')
    }
    private propertiesToXml(properties: Props | null): string {
        if (!properties) return '<Properties/>'

        const propertyXml = Object.entries(properties).map(([name, value]) => {
            if (value === null || value === undefined) {
                return `<Property name="${escape(name)}" nil="true"/>`
            }

            return `<Property name="${escape(name)}" type="${escape(this.propertyType(value))}">${escape(this.propertyValue(value))}</Property>`
        }).join('')

        return `<Properties>${propertyXml}</Properties>`
    }
    private propertyType(value: unknown): string {
        if (Array.isArray(value)) return 'array'
        return typeof value
    }

    private propertyValue(value: unknown): string {
        if (typeof value === 'string') return value
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
        return JSON.stringify(value) ?? String(value)
    }
}



async function collectHits(
    stream: ReadableStream<Hit>,
    limit: number,
    hits: Hit[]
): Promise<void> {
    if (limit <= 0) return

    const reader = stream.getReader()
    let collected = 0
    let done = false

    try {
        while (collected < limit) {
            const next = await reader.read()
            if (next.done) {
                done = true
                break
            }

            hits.push(next.value)
            collected += 1
        }
    } finally {
        if (!done) {
            await reader.cancel()
        }
        reader.releaseLock()
    }
}

function groupHitsByLayer(hits: Hit[]): Map<string, Hit[]> {
    const groups = new Map<string, Hit[]>()

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



