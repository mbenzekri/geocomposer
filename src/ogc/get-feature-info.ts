import type { Feature, Props } from '../core/feature.js'
import { createHitContext, pixelToCoordinate, type BBox, type CrsCode, type Position } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { escape } from '../core/tools.js'
import { HitFilter } from '../stream/hit-filter.js'

export const INFO_FORMATS = ['application/geo+json', 'application/json', 'text/xml', 'application/xml'] as const

export type InfoFormat = typeof INFO_FORMATS[number]

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
    hits: Feature[]
}

export type InfoTextResult = {
    body: string
    contentType: string
}

export type InfoContext = Omit<InfoResult, 'hits'> & {
    featureCount: number
}

export type InfoWritableStream<T> = WritableStream<Feature> & {
    result: Promise<T>
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
    infoFormat?: string
    formatted?: boolean
}

const INFO_LIMIT_REACHED = new Error('Info feature limit reached')


function getInfoFormater(format: string| undefined) {
    switch(format) {
        case 'application/geo+json' : return new GeoJsonFormatter();
        case 'application/json' : return new GeoJsonFormatter();
        case 'text/xml' : return new XmlFormatter();
        case 'application/xml' : return new XmlFormatter();
        
    }
    return new InfoResultFormatter()
}

export function getInfo(options: GetInfoOptions & { formatted: true }): Promise<InfoTextResult>
export function getInfo(options: GetInfoOptions): Promise<InfoResult>
export async function getInfo(options: GetInfoOptions): Promise<InfoResult | InfoTextResult> {

    const formatter = getInfoFormater(options.infoFormat)
    const point = pixelToCoordinate(options.bbox, options.width, options.height, options.i, options.j)
    const tolerancePixels = options.tolerancePixels ?? 4
    const hitContext = createHitContext(tolerancePixels, options.bbox, options.width, options.height, point)
    const infoContext: InfoContext = {
        crs: options.crs,
        bbox: options.bbox,
        width: options.width,
        height: options.height,
        pixel: {
            i: options.i,
            j: options.j
        },
        coordinate: point,
        featureCount: options.featureCount
    }
    const format = options.formatted ? normalizeInfoFormat(options.infoFormat) : undefined
    let limitReached = options.featureCount <= 0
    let abortCurrentLayer: (() => void) | undefined
    const output = formatter.writableStream(infoContext, () => {
        limitReached = true
        abortCurrentLayer?.()
    })

    for (const layer of options.layers) {
        if (limitReached) break

        const abortController = new AbortController()
        abortCurrentLayer = () => abortController.abort(INFO_LIMIT_REACHED)
        const layerHits = layer.query({
            bbox: hitContext.bbox,
            crs: options.crs,
            signal: abortController.signal
        }).pipeThrough(new HitFilter(hitContext))

        try {
            await layerHits.pipeTo(output, {
                preventAbort: true,
                preventClose: true,
                signal: abortController.signal
            })
        } catch (error) {
            if (abortController.signal.reason !== INFO_LIMIT_REACHED) {
                throw error
            }
        } finally {
            abortCurrentLayer = undefined
        }
    }

    const writer = output.getWriter()
    try {
        await writer.close()
    } finally {
        writer.releaseLock()
    }
    const result = await output.result

    return format
        ? {
            body: result as string,
            contentType: contentTypeForInfoFormat(format)
        }
        : result as InfoResult
}

export abstract class InfoFormatter<T = string> {
    abstract format(result: InfoResult): T

    writableStream(context: InfoContext, terminate: () => void = () => undefined): InfoWritableStream<T> {
        const hits: Feature[] = []
        const formatter = this
        let resolveResult!: (value: T) => void
        let rejectResult!: (reason?: unknown) => void
        const result = new Promise<T>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })

        const writable = new WritableStream<Feature>({
            write(feature) {
                if (hits.length >= context.featureCount) {
                    terminate()
                    return
                }

                hits.push(feature)
                if (hits.length >= context.featureCount) {
                    terminate()
                }
            },
            close() {
                try {
                    const { featureCount, ...resultContext } = context
                    resolveResult(formatter.format({
                        ...resultContext,
                        hits
                    }))
                } catch (error) {
                    rejectResult(error)
                    throw error
                }
            },
            abort(reason) {
                rejectResult(reason)
            }
        })

        return Object.assign(writable, { result })
    }
}

class InfoResultFormatter extends InfoFormatter<InfoResult> {
    format(result: InfoResult): InfoResult {
        return result
    }
}


class GeoJsonFormatter extends InfoFormatter {
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
            features: result.hits.map((feature) => this.toGeoJsonFeature(feature))
        })
    }
    private toGeoJsonFeature(source: Feature): Record<string, unknown> {
        const feature: Record<string, unknown> = {
            type: 'Feature',
            layer: source.layer.name,
            properties: this.normalizeJsonValue(source.properties ?? {}),
            geometry: source.geometry
        }

        if (source.id !== undefined) feature.id = source.id
        if (source.bbox) feature.bbox = source.bbox

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

class XmlFormatter extends InfoFormatter {
    format(result: InfoResult): string {
        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<FeatureInfoResponse version="1.3.0" crs="${escape(result.crs)}" numberReturned="${result.hits.length}">`,
            `<QueryPoint i="${result.pixel.i}" j="${result.pixel.j}" x="${result.coordinate[0]}" y="${result.coordinate[1]}"/>`,
            this.featuresToXml(result.hits),
            '</FeatureInfoResponse>'
        ].join('')
    }

    private featuresToXml(features: Feature[]): string {
        const xml: string[] = []
        let currentLayerName: string | null = null

        for (const feature of features) {
            const layerName = feature.layer.name
            if (layerName !== currentLayerName) {
                if (currentLayerName !== null) {
                    xml.push('</Layer>')
                }

                xml.push(`<Layer name="${escape(layerName)}">`)
                currentLayerName = layerName
            }

            xml.push(this.featureToXml(feature))
        }

        if (currentLayerName !== null) {
            xml.push('</Layer>')
        }

        return xml.join('')
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


function normalizeInfoFormat(value: string | undefined): InfoFormat {
    const format = (value ?? 'application/geo+json').toLowerCase()
    if (isInfoFormat(format)) return format

    throw new Error(`Unsupported INFO_FORMAT: ${value ?? ''}`)
}

function isInfoFormat(value: string): value is InfoFormat {
    return (INFO_FORMATS as readonly string[]).includes(value)
}

function contentTypeForInfoFormat(format: InfoFormat): string {
    return `${format}; charset=utf-8`
}
