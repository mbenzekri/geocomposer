import type { IncomingMessage, ServerResponse } from 'node:http'
import proj4 from 'proj4'
import type { BBox, CrsCode } from '../core/geometry.js'
import { MarkupTemplate } from '../core/template.js'
import { getInfo, INFO_FORMATS, type GetInfoOptions } from '../ogc/get-feature-info.js'
import { getMap } from '../ogc/get-map.js'
import { escape, paramsFromUrl, parseNonNegativeInt, parsePixelIndex, parsePositiveInt, Props } from '../core/tools.js'
import { Layer } from '../layer/layer.js'
import { Service } from './service-base.js'
import type { StyleFn } from '../style/style-fn.js'
import { Gt } from '../core/geotools.js'
import { DescInfo, ServiceInfo } from '../core/feature.js'
import { Crs } from '../core/crs.js'

const WMS_VERSION = '1.3.0'
const WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066


export type WmsOptions = DescInfo & ServiceInfo & {
    crs?: CrsCode[]
    layers: Layer[]
    maxWidth?: number
    maxHeight?: number
}

export type WmsJson = DescInfo & ServiceInfo & {
    maxWidth?: number
    maxHeight?: number
    layers?: string[]
}

export class Wms extends Service {
    private readonly maxWidth: number
    private readonly maxHeight: number
    private readonly layerByName: Map<string, Layer>
    private readonly crs: CrsCode[]
    private nextTraceId = 1
    private get layers() {
        return [...this.layerByName.values()]
    }

    constructor(options: WmsOptions) {
        super('wms', options.title, options.abstract, options.path ?? '/wms', options.onlineResource, options.cache)
        this.maxWidth = options.maxWidth ?? 4096
        this.maxHeight = options.maxHeight ?? 4096
        this.layerByName = new Map(options.layers.map((layer) => [layer.name, layer]))
        const crslist = (options.crs?.length ?? 0 > 0) ? options.crs : options.layers.map((layer) => layer.sourceCrs)
        this.crs = [...new Set(crslist)]
    }

    static fromConfig(entry: WmsJson): Wms {
        return new Wms({
            title: entry.title,
            abstract: entry.abstract,
            path: entry.path,
            maxWidth: entry.maxWidth,
            maxHeight: entry.maxHeight,
            onlineResource: entry.onlineResource,
            crs: Crs.registry.all.map((entry) => entry.code),
            layers: selectLayers(entry.layers, 'WMS')
        })
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const fullUrl = Service.requestUrl(req)
        const traceId = this.nextTraceId
        const startedAt = Date.now()

        try {
            Service.setCorsHeaders(res)

            if (req.method === 'OPTIONS') {
                res.statusCode = 204
                res.end()
                return
            }

            if (req.method !== 'GET' && req.method !== 'HEAD') {
                Service.sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
                return
            }

            const url = new URL(req.url ?? '/', 'http://localhost')
            if (!this.matches(url.pathname)) {
                Service.sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8')
                return
            }

            const params = paramsFromUrl(url)
            const request = (params.get('REQUEST') ?? 'GetCapabilities').toUpperCase()
            const service = params.get('SERVICE')

            if (service && service.toUpperCase() !== 'WMS') {
                this.sendWmsError(res, 'InvalidParameterValue', 'SERVICE must be WMS')
                return
            }

            if (request === 'GETCAPABILITIES') {
                const xml = await WmsCapabilitiesBuilder.build(this, this.layers, this.path, this.crs)
                Service.sendText(res, 200, xml, 'text/xml; charset=utf-8')
                return
            }

            if (request === 'GETMAP') {
                this.nextTraceId += 1
                this.logHandleStart(traceId, req.method ?? 'GET', fullUrl)

                const mapRequest = this.parseGetMap(params, this.layerByName, this.crs, this.maxWidth, this.maxHeight)
                this.logHandleParams(traceId, mapRequest)
                const image = await getMap({
                    layers: mapRequest.layers,
                    styles: mapRequest.styles,
                    bbox: mapRequest.bbox,
                    width: mapRequest.width,
                    height: mapRequest.height,
                    crs: mapRequest.crs,
                    pixelRatio: mapRequest.pixelRatio
                })

                res.statusCode = 200
                res.setHeader('Content-Type', mapRequest.format)
                res.setHeader('Content-Length', image.byteLength)
                if (req.method !== 'HEAD') {
                    res.end(image)
                    this.logHandleDone(traceId, res.statusCode, startedAt, image.byteLength)
                    return
                } else {
                    res.end()
                    this.logHandleDone(traceId, res.statusCode, startedAt, 0)

                }

                return
            }

            if (request === 'GETFEATUREINFO') {
                const infoRequest = this.parseGetFeatureInfo(params, this.layerByName, this.crs, this.maxWidth, this.maxHeight)
                const info = await getInfo(infoRequest)
                Service.sendText(res, 200, info.body, info.contentType, req.method === 'HEAD')
                return
            }

            this.sendWmsError(res, 'OperationNotSupported', `Unsupported REQUEST: ${params.get('REQUEST') ?? ''}`)
        } catch (error) {
            this.logHandleError(traceId, fullUrl, startedAt, error)
            this.sendWmsError(res, 'InvalidParameterValue', error instanceof Error ? error.message : String(error))
        }
    }

    private parseGetMap(
        params: Map<string, string>,
        layerByName: Map<string, Layer>,
        supportedCrs: CrsCode[],
        maxWidth: number,
        maxHeight: number
    ): MapRequest {
        const layerNames = this.require(params, 'LAYERS')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)

        if (layerNames.length === 0) {
            throw new Error('LAYERS must not be empty')
        }

        const selectedLayers = layerNames.map((name) => {
            const layer = layerByName.get(name)
            if (!layer) {
                throw new Error(`Unknown layer: ${name}`)
            }

            return layer
        })

        const version = params.get('VERSION') ?? WMS_VERSION
        const width = parsePositiveInt(this.require(params, 'WIDTH'), 'WIDTH', maxWidth)
        const height = parsePositiveInt(this.require(params, 'HEIGHT'), 'HEIGHT', maxHeight)
        const pixelRatio = parseWmsPixelRatio(params)
        const crs = params.get('CRS') ?? params.get('SRS')
        if (!crs) {
            throw new Error('CRS is required')
        }
        const rawBbox = this.require(params, 'BBOX')
        const parsedBbox = Gt.parseBBox(rawBbox, crs, version)
        validateCrs(supportedCrs, crs)
        const styleNames = parseStyles(params.get('STYLES'), selectedLayers.length)
        const layers = selectedLayers.map((layer, index) => layer);
        const styles = selectedLayers.map((layer, index) => resolveNamedStyle(layer, styleNames[index]))
        const format = params.get('FORMAT') ?? 'image/png'
        if (format !== 'image/png') {
            throw new Error(`Unsupported FORMAT: ${format}`)
        }

        return {
            layers,
            styles,
            layerNames,
            rawBbox,
            bbox: parsedBbox.bbox,
            bboxOrder: parsedBbox.order,
            width,
            height,
            crs,
            pixelRatio,
            version,
            format
        }
    }

    private parseGetFeatureInfo(
        params: Map<string, string>,
        layerByName: Map<string, Layer>,
        supportedCrs: CrsCode[],
        maxWidth: number,
        maxHeight: number
    ): InfoRequest {
        const mapRequest = this.parseGetMap(params, layerByName, supportedCrs, maxWidth, maxHeight)
        const queryLayerNames = this.require(params, 'QUERY_LAYERS')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)

        if (queryLayerNames.length === 0) {
            throw new Error('QUERY_LAYERS must not be empty')
        }

        const mapLayerNames = new Set(mapRequest.layerNames)
        const layers = queryLayerNames.map((name) => {
            if (!mapLayerNames.has(name)) {
                throw new Error(`QUERY_LAYERS layer "${name}" must also be present in LAYERS`)
            }

            const layer = layerByName.get(name)
            if (!layer) {
                throw new Error(`Unknown query layer: ${name}`)
            }

            return layer
        })
        const i = parsePixelIndex(params.get('I') ?? params.get('X'), mapRequest.version === '1.3.0' ? 'I' : 'X', mapRequest.width)
        const j = parsePixelIndex(params.get('J') ?? params.get('Y'), mapRequest.version === '1.3.0' ? 'J' : 'Y', mapRequest.height)
        const featureCount = params.has('FEATURE_COUNT')
            ? parsePositiveInt(this.require(params, 'FEATURE_COUNT'), 'FEATURE_COUNT', 100)
            : 1
        const tolerancePixels = params.has('BUFFER')
            ? parseNonNegativeInt(this.require(params, 'BUFFER'), 'BUFFER', 50)
            : 4
        const infoFormat = params.get('INFO_FORMAT') ?? undefined

        return {
            layers,
            rawBbox: mapRequest.rawBbox,
            bbox: mapRequest.bbox,
            bboxOrder: mapRequest.bboxOrder,
            width: mapRequest.width,
            height: mapRequest.height,
            crs: mapRequest.crs,
            version: mapRequest.version,
            i,
            j,
            featureCount,
            tolerancePixels,
            infoFormat,
            formatted: true
        }
    }
    logListening(baseUrl: string): void {
        console.log(`[WMS] GetMap : ${baseUrl}${this.path}?SERVICE=WMS&REQUEST=GetMap`)
        console.log(`[WMS] GetCapabilities: ${baseUrl}${this.path}?SERVICE=WMS&REQUEST=GetCapabilities`)
    }

    protected logHandleParams(traceId: number, request: MapRequest): void {
        console.debug(`[WMS] GetMap ${traceId}: BBOX raw  = ${request.rawBbox}`)
        console.debug(`[WMS] GetMap ${traceId}: BBOX used = ${request.bbox.join(',')}`)
        console.debug(`[WMS] GetMap ${traceId}: CRS=${request.crs} VERSION=${request.version} ORDER=${request.bboxOrder} SIZE=${request.width}x${request.height} PIXEL_RATIO=${request.pixelRatio}`)
    }
    private sendWmsError(res: ServerResponse, code: string, message: string): void {
        const body = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc">',
            `<ServiceException code="${escape(code)}">${escape(message)}</ServiceException>`,
            '</ServiceExceptionReport>'
        ].join('')

        Service.sendText(res, 400, body, 'text/xml; charset=utf-8')
    }
}

type MapRequest = {
    layers: Layer[]
    styles: StyleFn[]
    layerNames: string[]
    rawBbox: string
    bbox: BBox
    bboxOrder: 'xy' | 'yx'
    width: number
    height: number
    crs: CrsCode
    pixelRatio: number
    version: string
    format: string
}

type InfoRequest = GetInfoOptions & {
    rawBbox: string
    bboxOrder: 'xy' | 'yx'
    version: string
    formatted: true
}

type WmsBoundingBoxView = {
    crs: CrsCode
    minx: number
    miny: number
    maxx: number
    maxy: number
}

const WMS_CAPABILITIES_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="{{version}}" xmlns="http://www.opengis.net/wms">
  <Service>
    <Name>WMS</Name>
    <Title>{{service.title}}</Title>
    {{#service.abstract}}<Abstract>{{service.abstract}}</Abstract>{{/service.abstract}}
    {{#service.onlineResource}}<OnlineResource>{{service.onlineResource}}</OnlineResource>{{/service.onlineResource}}
  </Service>
  <Capability>
    <Request>
      <GetCapabilities><Format>text/xml</Format><DCPType><HTTP><Get><OnlineResource>{{onlineResource}}</OnlineResource></Get></HTTP></DCPType></GetCapabilities>
      <GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource>{{onlineResource}}</OnlineResource></Get></HTTP></DCPType></GetMap>
      <GetFeatureInfo>{{#featureInfoFormats}}<Format>{{.}}</Format>{{/featureInfoFormats}}<DCPType><HTTP><Get><OnlineResource>{{onlineResource}}</OnlineResource></Get></HTTP></DCPType></GetFeatureInfo>
    </Request>
    <Exception><Format>text/xml</Format></Exception>
    <Layer>
      <Title>{{service.title}}</Title>
      {{#crs}}<CRS>{{.}}</CRS>{{/crs}}
      {{#layers}}
      <Layer queryable="1">
        <Name>{{name}}</Name>
        <Title>{{title}}</Title>
        {{#summary}}<Abstract>{{summary}}</Abstract>{{/summary}}
        {{#crs}}<CRS>{{.}}</CRS>{{/crs}}
        {{#styles}}
        <Style>
          <Name>{{name}}</Name>
          <Title>{{title}}</Title>
          {{#summary}}<Abstract>{{summary}}</Abstract>{{/summary}}
        </Style>
        {{/styles}}
        {{#extent}}
        <EX_GeographicBoundingBox>
          <westBoundLongitude>{{west}}</westBoundLongitude>
          <eastBoundLongitude>{{east}}</eastBoundLongitude>
          <southBoundLatitude>{{south}}</southBoundLatitude>
          <northBoundLatitude>{{north}}</northBoundLatitude>
        </EX_GeographicBoundingBox>
        {{#boundingBoxes}}<BoundingBox CRS="{{crs}}" minx="{{minx}}" miny="{{miny}}" maxx="{{maxx}}" maxy="{{maxy}}"/>{{/boundingBoxes}}
        {{/extent}}
      </Layer>
      {{/layers}}
    </Layer>
  </Capability>
</WMS_Capabilities>`


class WmsCapabilitiesBuilder {
    static async build(service: Wms, layers: Layer[], path: string, crs: CrsCode[]): Promise<string> {
        const supportedCrs = [... new Set(crs)]
        const layerViews = []

        for (const layer of layers) {
            layerViews.push(await this.layerView(layer, supportedCrs))
        }

        return MarkupTemplate.render(WMS_CAPABILITIES_TEMPLATE, {
            version: WMS_VERSION,
            service,
            onlineResource: service.onlineResource ?? path,
            featureInfoFormats: INFO_FORMATS,
            crs: supportedCrs,
            layers: layerViews
        })
    }

    private static async layerView(layer: Layer, supportedCrs: CrsCode[]): Promise<Props> {
        const extent = await layer.getExtent()

        return {
            name: layer.name,
            title: layer.title ?? layer.name,
            summary: layer.summary,
            crs: supportedCrs,
            styles: layer.styles.map((style) => ({
                name: style.name,
                title: style.title ?? style.name,
                summary: style.abstract
            })),
            extent: extent ? this.extentView(extent, layer.sourceCrs, supportedCrs) : undefined
        }
    }

    private static extentView(bbox: BBox, sourceCrs: CrsCode, crs: CrsCode[]): Props {
        const geographicBbox = sourceCrs === 'EPSG:4326'
            ? bbox
            : transformBBox(bbox, sourceCrs, 'EPSG:4326') ?? bbox
        const boundingBoxes = crs
            .map((code) => {
                const targetBbox = code === sourceCrs
                    ? bbox
                    : transformBBox(bbox, sourceCrs, code)
                if (!targetBbox) return null

                const axisBbox = toWmsBoundingBox(targetBbox, code, WMS_VERSION)
                return {
                    crs: code,
                    minx: axisBbox[0],
                    miny: axisBbox[1],
                    maxx: axisBbox[2],
                    maxy: axisBbox[3]
                }
            })
            .filter((entry): entry is WmsBoundingBoxView => entry !== null)

        return {
            west: geographicBbox[0],
            east: geographicBbox[2],
            south: geographicBbox[1],
            north: geographicBbox[3],
            boundingBoxes
        }
    }


}

function transformBBox(bbox: BBox, sourceCrs: CrsCode, targetCrs: CrsCode): BBox | null {
    if (sourceCrs === targetCrs) return bbox

    const positions = [
        transformPosition([bbox[0], bbox[1]], sourceCrs, targetCrs),
        transformPosition([bbox[0], bbox[3]], sourceCrs, targetCrs),
        transformPosition([bbox[2], bbox[1]], sourceCrs, targetCrs),
        transformPosition([bbox[2], bbox[3]], sourceCrs, targetCrs)
    ]

    if (positions.some((position) => !position)) return null

    const points = positions as [number, number][]
    return [
        Math.min(...points.map((point) => point[0])),
        Math.min(...points.map((point) => point[1])),
        Math.max(...points.map((point) => point[0])),
        Math.max(...points.map((point) => point[1]))
    ]
}

function transformPosition(position: [number, number], sourceCrs: CrsCode, targetCrs: CrsCode): [number, number] | null {
    const x = position[0]
    const y = position[1]
    const [fromX, fromY] = sourceCrs === 'EPSG:4326' && targetCrs === 'EPSG:3857'
        ? [x, Gt.clamp(y, -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT)]
        : [x, y]

    try {
        return proj4(sourceCrs, targetCrs, [fromX, fromY]) as [number, number]
    } catch {
        return null
    }
}

function parseStyles(value: string | undefined, layerCount: number): Array<string | undefined> {
    if (value === undefined) {
        return Array.from({ length: layerCount }, () => undefined)
    }

    const styleNames = value.split(',').map((style) => style.trim())
    if (styleNames.length === 1 && styleNames[0] === '') {
        return Array.from({ length: layerCount }, () => undefined)
    }

    if (styleNames.length !== layerCount) {
        throw new Error('STYLES must include one entry per LAYERS entry')
    }

    return styleNames.map((style) => style || undefined)
}

function resolveNamedStyle(layer: Layer, styleName: string | undefined): StyleFn {
    return layer.resolveStyle(styleName)
}

function validateCrs(supportedCrs: CrsCode[], crs: CrsCode): void {
    if (supportedCrs.length > 0 && !supportedCrs.includes(crs)) {
        throw new Error(`CRS ${crs} is not supported by this service`)
    }
}



function toWmsBoundingBox(bbox: BBox, crs: CrsCode, version: string): BBox {
    if (Gt.usesLatLonAxisOrder(crs, version)) {
        return [bbox[1], bbox[0], bbox[3], bbox[2]]
    }

    return bbox
}




function parseWmsPixelRatio(params: Map<string, string>): number {
    const dpiValue = params.get('MAP_RESOLUTION')
        ?? params.get('DPI')
        ?? getFormatOptionsDpi(params.get('FORMAT_OPTIONS'))

    if (dpiValue === undefined) return 1

    const dpi = Number(dpiValue)
    if (!Number.isFinite(dpi) || dpi <= 0) {
        throw new Error('WMS DPI must be a positive number')
    }

    return dpi / 90
}

function getFormatOptionsDpi(value: string | undefined): string | undefined {
    if (!value) return undefined

    return value.match(/(?:^|;)\s*dpi\s*:\s*([^;]+)/i)?.[1]?.trim()
}



function selectLayers(layerNames: string[] | undefined, serviceName: string): Layer[] {

    if (!layerNames) return Layer.registry.all
    return layerNames.map((name) => {
        if (Layer.registry.has(name)) return Layer.registry.get(name)
        throw new Error(`Unknown layer "${name}" in ${serviceName} service`)
    })
}
