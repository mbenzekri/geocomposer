import type { CrsCode, BBox } from '../core/geometry.js'
import { Layer } from '../layer/layer.js'
import { StyleFn } from '../style/style-fn.js'
import { Dict, Registry } from '../core/tools.js'
import { DescInfo } from '../core/feature.js'
import { getTileMatrixSet, type TileMatrixSet } from './tile-matrix-set.js'

export const RASTER_TILE_FORMAT = 'image/png'
export const GEOJSON_TILE_FORMAT = 'application/geo+json'
export const MVT_TILE_FORMAT = 'application/vnd.mapbox-vector-tile'

export type TileOutput = {
    format: string
    extension: string
    vector: boolean
}

const TILE_FORMATS = new Map<string, TileOutput>([
    [RASTER_TILE_FORMAT, { format: RASTER_TILE_FORMAT, extension: 'png', vector: false }],
    [GEOJSON_TILE_FORMAT, { format: GEOJSON_TILE_FORMAT, extension: 'geojson', vector: true }],
    ['application/json', { format: GEOJSON_TILE_FORMAT, extension: 'geojson', vector: true }],
    [MVT_TILE_FORMAT, { format: MVT_TILE_FORMAT, extension: 'pbf', vector: true }],
    ['application/x-protobuf', { format: MVT_TILE_FORMAT, extension: 'pbf', vector: true }]
])
const DEFAULT_TILE_SIZE = 256
const DEFAULT_MIN_ZOOM = 0
const DEFAULT_MAX_ZOOM = 22
const DEFAULT_VECTOR_EXTENT = 4096
const DEFAULT_VECTOR_BUFFER = 64
const DEFAULT_VECTOR_TOLERANCE = 0.5
const DEFAULT_GEOJSON_PRECISION = 6

export type VectorTileGeneralizationOptions = {
    tolerance?: number
}

export type VectorTileOptions = {
    extent?: number
    buffer?: number
    generalization?: VectorTileGeneralizationOptions
    geojsonPrecision?: number
    maxFeatures?: number
}

export type TilesetLayerJson = {
    layer: string
    style?: string
}

export type TilesetLayerRefJson = string | TilesetLayerJson

export type TilesetJson = DescInfo & {
    tileMatrixSet?: string
    formats: string[]
    tileSize?: number
    minZoom?: number
    maxZoom?: number
    cacheControl?: string
    vector?: VectorTileOptions
    layers: TilesetLayerRefJson[]
}

export type RequiredVectorTileOptions = {
    extent: number
    buffer: number
    generalization: {
        tolerance: number
    }
    geojsonPrecision: number
    maxFeatures?: number
}

export class Tileset {
    static readonly registry = new Registry<Tileset>('TILESET')

    readonly id: string
    readonly title?: string
    readonly summary?: string
    readonly tileMatrixSet: TileMatrixSet
    readonly formats: string[]
    readonly tileSize: number
    readonly minZoom: number
    readonly maxZoom: number
    readonly cacheControl?: string
    readonly vector: RequiredVectorTileOptions
    readonly layers: Layer[]
    private readonly hasExplicitVectorOptions: boolean
    private readonly styleNames: ReadonlyArray<string | undefined>

    constructor(id: string, entry: TilesetJson) {
        const layerRefs = normalizeTilesetLayers(id, entry)

        this.id = id
        this.title = entry.title
        this.summary = entry.abstract
        this.tileMatrixSet = getTileMatrixSet(entry.tileMatrixSet)
        this.formats = normalizeTileFormats(entry.formats)
        this.tileSize = entry.tileSize ?? DEFAULT_TILE_SIZE
        this.minZoom = entry.minZoom ?? DEFAULT_MIN_ZOOM
        this.maxZoom = entry.maxZoom ?? DEFAULT_MAX_ZOOM
        this.cacheControl = entry.cacheControl
        this.hasExplicitVectorOptions = entry.vector !== undefined
        this.vector = normalizeVectorOptions(entry.vector)
        this.layers = layerRefs.map((ref) => resolveTilesetLayer(ref, id))
        this.styleNames = layerRefs.map((ref) => ref.style)
        this.resolveStyles()
        this.validate()
    }

    static build(tilesetEntries: Dict<TilesetJson>): Registry<Tileset> {
        for (const [name, entry] of Object.entries(tilesetEntries)) {
            const tileset = Tileset.create(name, entry)
            Tileset.registry.set(name, tileset)
        }
        return Tileset.registry
    }

    static create(
        name: string,
        entry: TilesetJson
    ): Tileset {
        return new Tileset(name, entry)
    }

    static select(names: string[] | undefined, serviceName: string): Tileset[] {
        if (!names) {
            if (Tileset.registry.all.length > 0) return Tileset.registry.all
            throw new Error(`${serviceName} service requires at least one configured tileset`)
        }

        const selected = names.map((name) => {
            const tileset = Tileset.registry.get(name)
            if (tileset) return tileset
            throw new Error(`Unknown tileset "${name}" in ${serviceName} service`)
        })

        if (selected.length > 0) return selected
        throw new Error(`${serviceName} service requires at least one tileset`)
        
    }

    get crs(): CrsCode {
        return this.tileMatrixSet.crs
    }

    bbox(z: number, x: number, y: number): BBox {
        this.validateCoord(z, x, y)
        return this.tileMatrixSet.bbox(z, x, y)
    }

    validateCoord(z: number, x: number, y: number): void {
        if (z < this.minZoom || z > this.maxZoom) {
            throw new Error(`z must be between ${this.minZoom} and ${this.maxZoom}`)
        }

        const tilesPerAxis = 2 ** z
        if (x < 0 || x >= tilesPerAxis || y < 0 || y >= tilesPerAxis) {
            throw new Error(`x and y must be between 0 and ${tilesPerAxis - 1} at z=${z}`)
        }
    }

    zoomFromMatrixId(value: string): number {
        return this.tileMatrixSet.zoomFromMatrixId(value)
    }

    get defaultFormat(): string {
        return this.formats[0]
    }

    get outputs(): TileOutput[] {
        return this.formats.map((format) => tileFormatInfo(format))
    }

    get hasVectorFormats(): boolean {
        return this.outputs.some((output) => output.vector)
    }

    resolveOutput(format?: string): TileOutput {
        const normalized = normalizeTileFormat(format ?? this.defaultFormat)
        if (!this.formats.includes(normalized)) {
            throw new Error(`Tileset "${this.id}" does not support format "${normalized}"`)
        }

        return tileFormatInfo(normalized)
    }

    supportsFormat(value: string): boolean {
        return this.formats.includes(normalizeTileFormat(value))
    }

    resolveStyles(): StyleFn[] {
        return this.layers.map((layer, index) => resolveTilesetStyle(layer, this.styleNames[index], this.id))
    }

    private validate(): void {
        if (!this.id) {
            throw new Error('Tileset id must not be empty')
        }

        if (!Number.isInteger(this.tileSize) || this.tileSize <= 0) {
            throw new Error(`Tileset "${this.id}" tileSize must be a positive integer`)
        }

        if (!Number.isInteger(this.minZoom) || this.minZoom < 0) {
            throw new Error(`Tileset "${this.id}" minZoom must be a non-negative integer`)
        }

        if (!Number.isInteger(this.maxZoom) || this.maxZoom < this.minZoom) {
            throw new Error(`Tileset "${this.id}" maxZoom must be an integer greater than or equal to minZoom`)
        }

        if (this.layers.length === 0) {
            throw new Error(`Tileset "${this.id}" must reference at least one configured layer`)
        }

        if (!this.hasVectorFormats) {
            if (this.hasExplicitVectorOptions) {
                throw new Error(`Tileset "${this.id}" vector options require at least one vector output format`)
            }

            return
        }

        if (!Number.isInteger(this.vector.extent) || this.vector.extent <= 0) {
            throw new Error(`Tileset "${this.id}" vector.extent must be a positive integer`)
        }

        if (!Number.isFinite(this.vector.buffer) || this.vector.buffer < 0) {
            throw new Error(`Tileset "${this.id}" vector.buffer must be a non-negative number`)
        }

        if (!Number.isFinite(this.vector.generalization.tolerance) || this.vector.generalization.tolerance < 0) {
            throw new Error(`Tileset "${this.id}" vector.generalization.tolerance must be a non-negative number`)
        }

        if (!Number.isInteger(this.vector.geojsonPrecision) || this.vector.geojsonPrecision < 0) {
            throw new Error(`Tileset "${this.id}" vector.geojsonPrecision must be a non-negative integer`)
        }

        if (this.vector.maxFeatures !== undefined && (!Number.isInteger(this.vector.maxFeatures) || this.vector.maxFeatures <= 0)) {
            throw new Error(`Tileset "${this.id}" vector.maxFeatures must be a positive integer`)
        }
    }
}

export function normalizeTileFormat(format: string): string {
    const info = TILE_FORMATS.get(format)
    if (!info) {
        throw new Error(`Unsupported tileset format "${format}"`)
    }

    return info.format
}

export function normalizeTileFormats(formats: string[]): string[] {
    if (!Array.isArray(formats) || formats.length === 0) {
        throw new Error('Tileset formats must define at least one output format')
    }

    const normalized = formats.map((format) => normalizeTileFormat(format))
    const unique = [...new Set(normalized)]
    if (unique.length !== normalized.length) {
        throw new Error(`Tileset formats must not contain duplicates: ${normalized.join(', ')}`)
    }

    return unique
}

export function tileFormatFromExtension(extension: string): string {
    switch (extension.toLowerCase()) {
        case 'png':
            return RASTER_TILE_FORMAT
        case 'geojson':
        case 'json':
            return GEOJSON_TILE_FORMAT
        case 'pbf':
        case 'mvt':
            return MVT_TILE_FORMAT
        default:
            return normalizeTileFormat(extension)
    }
}

function tileFormatInfo(format: string): TileOutput {
    const info = TILE_FORMATS.get(format)
    if (!info) {
        throw new Error(`Unsupported tileset format "${format}"`)
    }

    return info
}

function normalizeVectorOptions(options: VectorTileOptions | undefined): RequiredVectorTileOptions {
    return {
        extent: options?.extent ?? DEFAULT_VECTOR_EXTENT,
        buffer: options?.buffer ?? DEFAULT_VECTOR_BUFFER,
        generalization: {
            tolerance: options?.generalization?.tolerance ?? DEFAULT_VECTOR_TOLERANCE
        },
        geojsonPrecision: options?.geojsonPrecision ?? DEFAULT_GEOJSON_PRECISION,
        maxFeatures: options?.maxFeatures
    }
}

function normalizeTilesetLayers(name: string, entry: TilesetJson): TilesetLayerJson[] {
    if (!entry.layers || entry.layers.length === 0) {
        throw new Error(`Tileset "${name}" must define at least one entry in "layers"`)
    }

    return entry.layers.map((ref) => {
        if (typeof ref === 'string') {
            return {
                layer: ref
            }
        }

        return {
            layer: ref.layer,
            style: ref.style
        }
    })
}

function resolveTilesetLayer(ref: TilesetLayerJson, tilesetName: string): Layer {
    if (!Layer.registry.has(ref.layer)) {
        throw new Error(`Unknown layer "${ref.layer}" in tileset "${tilesetName}"`)
    }

    return Layer.registry.get(ref.layer)
}

function resolveTilesetStyle(layer: Layer, styleName: string | undefined, tilesetName: string): StyleFn {
    try {
        return layer.resolveStyle(styleName)
    } catch (error) {
        if (!styleName) throw error
        throw new Error(`Unknown style "${styleName}" for layer "${layer.id}" in tileset "${tilesetName}"`)
    }
}
