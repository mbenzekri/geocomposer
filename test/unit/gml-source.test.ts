import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Layer } from '../../src/layer/layer.js'
import { GmlSource } from '../../src/source/gml-source.js'

const layer = {
    name: 'gml-layer',
    crs: 'EPSG:4326'
} as Layer

let tmpDir: string

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gml-source-'))
})

afterEach(() => {
    fs.rmSync(tmpDir, {
        recursive: true,
        force: true
    })
})

function writeFile(name: string, content: string): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, content)
    return file
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader()
    const values: T[] = []

    try {
        for (;;) {
            const result = await reader.read()
            if (result.done) return values
            values.push(result.value)
        }
    } finally {
        reader.releaseLock()
    }
}

describe('GmlSource', () => {
    it('accepts gml config entries', () => {
        expect(GmlSource.acceptsConfig({
            type: 'gml',
            path: 'data.gml'
        })).toBe(true)
    })

    it('rejects non gml config entries', () => {
        expect(GmlSource.acceptsConfig({ type: 'geojson' })).toBe(false)
        expect(GmlSource.acceptsConfig(null)).toBe(false)
        expect(GmlSource.acceptsConfig([])).toBe(false)
        expect(GmlSource.acceptsConfig('gml')).toBe(false)
    })

    it('creates a source from config and exposes file list', () => {
        const source = GmlSource.fromConfig('roads', {
            type: 'gml',
            path: 'roads.gml',
            encoding: 'utf8',
            highWaterMark: 32,
            featureElementNames: ['featureMember'],
            geometryPropertyNames: ['geom'],
            axisOrder: 'xy'
        })

        expect(source.id).toBe('roads')
        expect(source.type).toBe('gml')
        expect(source.storage).toBe('file')
        expect(source.getFiles()).toEqual([
            {
                role: 'data',
                path: 'roads.gml'
            }
        ])
    })

    it('streams featureMember features with properties and point geometry', async () => {
        const file = writeFile('features.gml', `
            <gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml">
                <gml:featureMember>
                    <app:city gml:id="city.1" xmlns:app="http://example.test">
                        <app:name>Paris</app:name>
                        <app:population>2148000</app:population>
                        <app:enabled>true</app:enabled>
                        <app:empty></app:empty>
                        <app:nilValue xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">ignored</app:nilValue>
                        <app:geom>
                            <gml:Point srsName="EPSG:3857">
                                <gml:pos>2 48</gml:pos>
                            </gml:Point>
                        </app:geom>
                    </app:city>
                </gml:featureMember>
            </gml:FeatureCollection>
        `)

        const source = new GmlSource('cities', file, {
            axisOrder: 'xy',
            highWaterMark: 16
        })

        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
            type: 'Feature',
            id: 'city.1',
            layer,
            crs: 'EPSG:4326',
            properties: {
                name: 'Paris',
                population: 2148000,
                enabled: true,
                empty: null,
                nilValue: null
            },
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            },
            sourceRef: {
                storage: 'file',
                sourceId: 'cities',
                recordIndex: 0
            }
        })
    })

    it('streams member features and unwraps the contained feature element', async () => {
        const file = writeFile('features.gml', `
            <root>
                <member>
                    <place id="place-1">
                        <name>Nice</name>
                        <geometry>
                            <Point>
                                <coordinates>7,43</coordinates>
                            </Point>
                        </geometry>
                    </place>
                </member>
            </root>
        `)

        const source = new GmlSource('places', file)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
            id: 'place-1',
            properties: {
                name: 'Nice'
            },
            geometry: {
                type: 'Point',
                coordinates: [7, 43]
            }
        })
    })

    it('reads a streamed feature from its sourceRef', async () => {
        const file = writeFile('features.gml', `
            <root>
                <featureMember>
                    <city id="city-1">
                        <name>Lyon</name>
                        <geom>
                            <Point>
                                <pos>4 45</pos>
                            </Point>
                        </geom>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const [streamed] = await readAll(source.stream({ layer }))
        const read = await source.read(streamed.sourceRef!, { layer })

        expect(read).toMatchObject({
            id: 'city-1',
            type: 'Feature',
            layer,
            crs: 'EPSG:4326',
            properties: {
                name: 'Lyon'
            },
            geometry: {
                type: 'Point',
                coordinates: [4, 45]
            },
            sourceRef: streamed.sourceRef
        })
    })

    it('applies transformFeature to streamed and read features', async () => {
        const file = writeFile('features.gml', `
            <root>
                <featureMember>
                    <city>
                        <name>A</name>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file, {
            transformFeature: (feature, index) => ({
                ...feature,
                id: `generated-${index}`
            })
        })

        const [streamed] = await readAll(source.stream({ layer }))
        const read = await source.read(streamed.sourceRef!, { layer })

        expect(streamed.id).toBe('generated-0')
        expect(read?.id).toBe('generated-0')
    })

    it('parses LineString from posList', async () => {
        const file = writeFile('line.gml', `
            <root>
                <featureMember>
                    <road>
                        <geom>
                            <LineString>
                                <posList>0 0 10 10 20 5</posList>
                            </LineString>
                        </geom>
                    </road>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('roads', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [10, 10],
                [20, 5]
            ]
        })
    })

    it('parses LineString from repeated pos elements', async () => {
        const file = writeFile('line.gml', `
            <root>
                <featureMember>
                    <road>
                        <geom>
                            <LineString>
                                <pos>0 0</pos>
                                <pos>10 10</pos>
                            </LineString>
                        </geom>
                    </road>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('roads', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [10, 10]
            ]
        })
    })

    it('parses Curve from LineStringSegment elements', async () => {
        const file = writeFile('curve.gml', `
            <root>
                <featureMember>
                    <road>
                        <geom>
                            <Curve>
                                <segments>
                                    <LineStringSegment>
                                        <posList>0 0 1 1</posList>
                                    </LineStringSegment>
                                    <LineStringSegment>
                                        <posList>2 2 3 3</posList>
                                    </LineStringSegment>
                                </segments>
                            </Curve>
                        </geom>
                    </road>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('roads', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [1, 1],
                [2, 2],
                [3, 3]
            ]
        })
    })

    it('parses Curve using fallback positions when no segment exists', async () => {
        const file = writeFile('curve.gml', `
            <root>
                <featureMember>
                    <road>
                        <geom>
                            <Curve>
                                <posList>0 0 1 1</posList>
                            </Curve>
                        </geom>
                    </road>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('roads', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [1, 1]
            ]
        })
    })

    it('parses Polygon with exterior and interior rings', async () => {
        const file = writeFile('polygon.gml', `
            <root>
                <featureMember>
                    <area>
                        <geom>
                            <Polygon>
                                <exterior>
                                    <LinearRing>
                                        <posList>0 0 10 0 10 10 0 10 0 0</posList>
                                    </LinearRing>
                                </exterior>
                                <interior>
                                    <LinearRing>
                                        <posList>2 2 4 2 4 4 2 4 2 2</posList>
                                    </LinearRing>
                                </interior>
                            </Polygon>
                        </geom>
                    </area>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('areas', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
                [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
            ]
        })
    })

    it('parses Polygon from legacy boundary element names', async () => {
        const file = writeFile('polygon.gml', `
            <root>
                <featureMember>
                    <area>
                        <geom>
                            <Polygon>
                                <outerBoundaryIs>
                                    <LinearRing>
                                        <coordinates>0,0 1,0 1,1 0,0</coordinates>
                                    </LinearRing>
                                </outerBoundaryIs>
                                <innerBoundaryIs>
                                    <LinearRing>
                                        <coordinates>0.2,0.2 0.4,0.2 0.4,0.4 0.2,0.2</coordinates>
                                    </LinearRing>
                                </innerBoundaryIs>
                            </Polygon>
                        </geom>
                    </area>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('areas', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [1, 0], [1, 1], [0, 0]],
                [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]]
            ]
        })
    })

    it('parses Polygon using LinearRing fallback', async () => {
        const file = writeFile('polygon.gml', `
            <root>
                <featureMember>
                    <area>
                        <geom>
                            <Polygon>
                                <LinearRing>
                                    <posList>0 0 1 0 1 1 0 0</posList>
                                </LinearRing>
                            </Polygon>
                        </geom>
                    </area>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('areas', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [1, 0], [1, 1], [0, 0]]
            ]
        })
    })

    it('parses MultiPoint', async () => {
        const file = writeFile('multipoint.gml', `
            <root>
                <featureMember>
                    <places>
                        <geom>
                            <MultiPoint>
                                <pointMember><Point><pos>1 2</pos></Point></pointMember>
                                <pointMember><Point><pos>3 4</pos></Point></pointMember>
                            </MultiPoint>
                        </geom>
                    </places>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('places', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'MultiPoint',
            coordinates: [
                [1, 2],
                [3, 4]
            ]
        })
    })

    it('parses MultiCurve as LineString when it contains one line', async () => {
        const file = writeFile('multicurve.gml', `
            <root>
                <featureMember>
                    <roads>
                        <geom>
                            <MultiCurve>
                                <curveMember>
                                    <LineString>
                                        <posList>0 0 1 1</posList>
                                    </LineString>
                                </curveMember>
                            </MultiCurve>
                        </geom>
                    </roads>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('roads', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [1, 1]
            ]
        })
    })

    it('parses MultiCurve as MultiLineString when it contains multiple lines', async () => {
        const file = writeFile('multicurve.gml', `
            <root>
                <featureMember>
                    <roads>
                        <geom>
                            <MultiCurve>
                                <curveMember>
                                    <LineString>
                                        <posList>0 0 1 1</posList>
                                    </LineString>
                                </curveMember>
                                <curveMember>
                                    <Curve>
                                        <posList>2 2 3 3</posList>
                                    </Curve>
                                </curveMember>
                            </MultiCurve>
                        </geom>
                    </roads>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('roads', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'MultiLineString',
            coordinates: [
                [[0, 0], [1, 1]],
                [[2, 2], [3, 3]]
            ]
        })
    })

    it('parses MultiSurface as Polygon when it contains one polygon', async () => {
        const file = writeFile('multisurface.gml', `
            <root>
                <featureMember>
                    <areas>
                        <geom>
                            <MultiSurface>
                                <surfaceMember>
                                    <Polygon>
                                        <exterior>
                                            <LinearRing>
                                                <posList>0 0 1 0 1 1 0 0</posList>
                                            </LinearRing>
                                        </exterior>
                                    </Polygon>
                                </surfaceMember>
                            </MultiSurface>
                        </geom>
                    </areas>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('areas', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [1, 0], [1, 1], [0, 0]]
            ]
        })
    })

    it('parses MultiSurface as MultiPolygon when it contains multiple polygons', async () => {
        const file = writeFile('multisurface.gml', `
            <root>
                <featureMember>
                    <areas>
                        <geom>
                            <MultiSurface>
                                <surfaceMember>
                                    <Polygon>
                                        <exterior><LinearRing><posList>0 0 1 0 1 1 0 0</posList></LinearRing></exterior>
                                    </Polygon>
                                </surfaceMember>
                                <surfaceMember>
                                    <Surface>
                                        <exterior><Ring><posList>2 2 3 2 3 3 2 2</posList></Ring></exterior>
                                    </Surface>
                                </surfaceMember>
                            </MultiSurface>
                        </geom>
                    </areas>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('areas', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                [[[2, 2], [3, 2], [3, 3], [2, 2]]]
            ]
        })
    })

    it('uses yx axis order when explicitly configured', async () => {
        const file = writeFile('point.gml', `
            <root>
                <featureMember>
                    <city>
                        <geom>
                            <Point>
                                <pos>48 2</pos>
                            </Point>
                        </geom>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file, {
            axisOrder: 'yx'
        })

        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Point',
            coordinates: [2, 48]
        })
    })

    it('uses yx axis order automatically for EPSG:4326', async () => {
        const file = writeFile('point.gml', `
            <root>
                <featureMember>
                    <city>
                        <geom>
                            <Point srsName="urn:ogc:def:crs:EPSG::4326">
                                <pos>48 2</pos>
                            </Point>
                        </geom>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Point',
            coordinates: [2, 48]
        })
    })

    it('keeps extra dimensions from srsDimension', async () => {
        const file = writeFile('point.gml', `
            <root>
                <featureMember>
                    <city>
                        <geom>
                            <Point srsDimension="3">
                                <pos>1 2 99</pos>
                            </Point>
                        </geom>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'Point',
            coordinates: [1, 2, 99]
        })
    })

    it('decodes XML entities in properties and coordinates', async () => {
        const file = writeFile('entities.gml', `
            <root>
                <featureMember>
                    <city>
                        <name>Tom &amp; Jerry &lt;test&gt; &quot;x&quot; &apos;y&apos;</name>
                        <geom>
                            <Point>
                                <coordinates>1,2</coordinates>
                            </Point>
                        </geom>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.properties).toEqual({
            name: `Tom & Jerry <test> "x" 'y'`
        })
        expect(feature.geometry).toEqual({
            type: 'Point',
            coordinates: [1, 2]
        })
    })

    it('ignores boundedBy, configured geometry properties and properties containing geometry', async () => {
        const file = writeFile('properties.gml', `
            <root>
                <featureMember>
                    <city>
                        <boundedBy>ignored</boundedBy>
                        <geom>
                            <Point><pos>1 2</pos></Point>
                        </geom>
                        <customGeometry>
                            <Point><pos>3 4</pos></Point>
                        </customGeometry>
                        <name>A</name>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file, {
            geometryPropertyNames: ['geom']
        })

        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.properties).toEqual({
            name: 'A'
        })
    })

    it('returns null geometry when no geometry element exists', async () => {
        const file = writeFile('nogeom.gml', `
            <root>
                <featureMember>
                    <city>
                        <name>No geometry</name>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toBeNull()
    })

    it('throws when sourceRef belongs to another source', async () => {
        const file = writeFile('features.gml', '<root/>')
        const source = new GmlSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'other',
            offset: 0,
            byteLength: 1
        }, { layer })).rejects.toThrow(
            'GML sourceRef belongs to "other", expected "cities"'
        )
    })

    it('throws when sourceRef has no offset', async () => {
        const file = writeFile('features.gml', '<root/>')
        const source = new GmlSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            byteLength: 1
        } as any, { layer })).rejects.toThrow(
            'GML sourceRef must include offset and byteLength'
        )
    })

    it('throws when sourceRef has no byteLength', async () => {
        const file = writeFile('features.gml', '<root/>')
        const source = new GmlSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 0
        } as any, { layer })).rejects.toThrow(
            'GML sourceRef must include offset and byteLength'
        )
    })

    it('throws when sourceRef byte range exceeds file length', async () => {
        const file = writeFile('features.gml', '<root/>')
        const source = new GmlSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 0,
            byteLength: 999
        }, { layer })).rejects.toThrow(
            'Invalid GML sourceRef: byte range exceeds file length'
        )
    })

    it('throws when read sourceRef points to invalid XML', async () => {
        const file = writeFile('invalid.gml', 'not xml')
        const source = new GmlSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 0,
            byteLength: fs.statSync(file).size
        }, { layer })).rejects.toThrow(
            'Invalid GML: expected a feature XML element'
        )
    })

    it('throws when a feature element is unfinished at end of stream', async () => {
        const file = writeFile('invalid.gml', `
            <root>
                <featureMember>
                    <city>
            </root>
        `)

        const source = new GmlSource('cities', file)

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GML: unfinished feature element'
        )
    })

    it('uses GML stream aborted as abort reason', async () => {
        const file = writeFile('features.gml', '<root/>')
        const controller = new AbortController()
        controller.abort('GML stream aborted')

        const source = new GmlSource('cities', file)
        const reader = source.stream({
            layer,
            signal: controller.signal
        }).getReader()

        await expect(reader.read()).rejects.toBe('GML stream aborted')
    })

    it('supports XML comments, processing instructions and CDATA while scanning', async () => {
        const file = writeFile('special.gml', `
            <?xml version="1.0"?>
            <!-- comment -->
            <!DOCTYPE root>
            <root>
                <![CDATA[ ignored text ]]>
                <featureMember>
                    <city>
                        <name><![CDATA[Paris]]></name>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].properties).toEqual({
            name: 'Paris'
        })
    })

    it('handles feature elements split across small chunks', async () => {
        const file = writeFile('chunked.gml', `
            <root>
                <featureMember>
                    <city id="a">
                        <name>A</name>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file, {
            highWaterMark: 1
        })

        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
    })

    it('handles large prefixes and trims the internal parser buffer', async () => {
        const file = writeFile('large.gml', `
            <root>
                <metadata>${'x'.repeat(70000)}</metadata>
                <featureMember>
                    <city id="a">
                        <name>A</name>
                    </city>
                </featureMember>
            </root>
        `)

        const source = new GmlSource('cities', file)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
    })
})