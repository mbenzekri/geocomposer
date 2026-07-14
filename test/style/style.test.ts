import { writeFileSync } from 'node:fs'
import { Image as CanvasImage } from 'canvas'
import Fill from 'ol/style/Fill.js'
import Stroke from 'ol/style/Stroke.js'
import Text from 'ol/style/Text.js'
import OlStyle from 'ol/style/Style.js'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import { DEFAULT_DPI, INCHES_PER_METER, METERS_PER_DEGREE } from '../../src/core/geometry.js'
import { defaultStyleFn } from '../../src/style/default-style.js'
import { createDynamicStyleFn, DynamicStyle, type DynamicStyleJson } from '../../src/style/dynamic-style.js'
import { createStyleContext } from '../../src/style/style-fn.js'
import { Style } from '../../src/style/style.js'
import {
  copyTextRenderMetadata,
  getStyleTextDeclutterMode,
  getStyleTextDeclutterRank,
  getStyleTextRenderStep,
  getTextDeclutterMode,
  getTextDeclutterRank,
  getTextRenderStep,
  setTextDeclutterMode,
  setTextDeclutterRank,
  setTextRenderStep
} from '../../src/style/text-render-step.js'
import { testTempPath, writeTestConfig } from '../test-temp.js'

type StyleResult = OlStyle | OlStyle[] | null

const originalDocument = globalThis.document
const originalImage = globalThis.Image

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement(name: string) {
      if (name !== 'canvas') return null
      return {
        getContext(type: string) {
          if (type !== '2d') return null
          const gradient = () => ({
            stops: [] as Array<[number, string]>,
            addColorStop(offset: number, color: string) {
              this.stops.push([offset, color])
            }
          })
          return {
            createLinearGradient: gradient,
            createRadialGradient: gradient,
            createConicGradient: gradient,
            createPattern: () => ({ pattern: true })
          }
        }
      }
    }
  })
  vi.stubGlobal('Image', undefined)
})

afterAll(() => {
  vi.stubGlobal('document', originalDocument)
  vi.stubGlobal('Image', originalImage)
})

beforeEach(() => {
  Style.registry.clear()
})

describe('default style', () => {
  test('returns stable OpenLayers styles by geometry family', () => {
    const point = defaultStyleFn(feature({ geometry: { type: 'Point', coordinates: [0, 0] } }), 1)
    const multipoint = defaultStyleFn(feature({ geometry: { type: 'MultiPoint', coordinates: [[0, 0]] } }), 1)
    const line = defaultStyleFn(feature({ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }), 1)
    const multiline = defaultStyleFn(feature({ geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] } }), 1)
    const polygon = defaultStyleFn(feature({ geometry: polygonGeometry() }), 1)
    const multipolygon = defaultStyleFn(feature({ geometry: { type: 'MultiPolygon', coordinates: [polygonCoordinates()] } }), 1)

    expect(point).toBe(multipoint)
    expect(asStyle(point).getImage()).toBeTruthy()
    expect(line).toBe(multiline)
    expect(asStyle(line).getStroke()?.getColor()).toBe('#0055ff')
    expect(polygon).toBe(multipolygon)
    expect(asStyle(polygon).getFill()?.getColor()).toBe('rgba(0, 85, 255, 0.15)')
    expect(defaultStyleFn(feature({ geometry: null }), 1)).toBeNull()
  })
})

describe('style context', () => {
  test('computes CRS-aware map resolutions and scale denominator', () => {
    const context = createStyleContext('EPSG:4326', [-1, -1, 1, 1], 0.01, 2)
    expect(context.crs).toBe('EPSG:4326')
    expect(context.resolutionByUnit?.m).toBeGreaterThan(2200)
    expect(context.resolutionByUnit?.dd).toBeCloseTo((context.resolutionByUnit?.m ?? 0) / METERS_PER_DEGREE)
    expect(context.scaleDenominator).toBeCloseTo((context.resolutionByUnit?.m ?? 0) * INCHES_PER_METER * DEFAULT_DPI)
  })
})

describe('text render metadata', () => {
  test('defaults null text and stores normalized metadata on Text instances', () => {
    const text = new Text({ text: 'city' })
    const style = new OlStyle({ text })

    expect(getTextRenderStep(null)).toBe('layer')
    expect(getTextDeclutterMode(null)).toBe('none')
    expect(getTextDeclutterRank(null)).toBe(0)
    expect(getStyleTextRenderStep(style)).toBe('layer')

    setTextRenderStep(text, 'map')
    setTextDeclutterMode(text, 'rank')
    setTextDeclutterRank(text, '7.5')

    expect(getStyleTextRenderStep(style)).toBe('map')
    expect(getStyleTextDeclutterMode(style)).toBe('rank')
    expect(getStyleTextDeclutterRank(style)).toBe(7.5)
  })

  test('copies metadata and rejects invalid metadata values', () => {
    const source = new Text({ text: 'source' })
    const target = new Text({ text: 'target' })

    setTextRenderStep(source, 'overlay')
    setTextDeclutterMode(source, 'first')
    setTextDeclutterRank(source, 3)
    copyTextRenderMetadata(source, target)

    expect(getTextRenderStep(target)).toBe('overlay')
    expect(getTextDeclutterMode(target)).toBe('first')
    expect(getTextDeclutterRank(target)).toBe(3)
    expect(() => setTextRenderStep(source, 'tile')).toThrow('Invalid text render step')
    expect(() => setTextDeclutterMode(source, 'closest')).toThrow('Invalid text declutter mode')
    expect(() => setTextDeclutterRank(source, 'high')).toThrow('Invalid text declutter rank')
  })
})

describe('dynamic style', () => {
  test('returns null for empty style collections and skipped style parts', async () => {
    const styleFn = await createDynamicStyleFn('empty', {
      static: {
        skipped: {
          when: false,
          fill: { color: 'red' }
        },
        empty: {
          fill: false,
          stroke: null,
          image: { when: false, radius: 4 },
          text: { when: false, text: 'hidden' }
        },
        unknownImage: {
          image: { type: 'Unknown' }
        }
      }
    })

    const styles = asStyleArray(styleFn(feature(), 1))

    expect(styles).toHaveLength(2)
    expect(styles.every((style) => !style.getFill() && !style.getStroke() && !style.getImage() && !style.getText())).toBe(true)
  })

  test('builds static fills, strokes, circles, regular shapes, text metadata and typed definitions', async () => {
    const styleFn = await createDynamicStyleFn('landmarks', {
      definitions: {
        labelFill: { type: 'Fill', color: 'black' }
      },
      static: {
        polygon: {
          fill: { color: 'rgba(1, 2, 3, 0.4)' },
          stroke: { color: '#123456', width: 2 },
          text: {
            text: '=> F.get("name")',
            color: '#111111',
            backgroundFill: { color: '#eeeeee' },
            step: 'overlay',
            declutter: 'rank',
            rank: '=> F.get("rank")'
          },
          zIndex: 5
        },
        circle: {
          image: {
            type: 'Circle',
            radius: 6,
            fill: { color: '=> D.labelFill.getColor()' },
            stroke: { color: '#ffffff', width: 1 }
          }
        },
        shape: {
          image: {
            type: 'RegularShape',
            points: 4,
            radius: 8,
            fill: { color: '#ff00aa' }
          }
        }
      }
    })

    const styles = asStyleArray(styleFn(feature({ properties: { name: 'Paris', rank: 9 }, geometry: polygonGeometry() }), 1))

    expect(styles).toHaveLength(3)
    expect(styles[0].getFill()?.getColor()).toBe('rgba(1, 2, 3, 0.4)')
    expect(styles[0].getStroke()?.getWidth()).toBe(2)
    expect(styles[0].getText()?.getText()).toBe('Paris')
    expect(styles[0].getZIndex()).toBe(5)
    expect(getStyleTextRenderStep(styles[0])).toBe('overlay')
    expect(getStyleTextDeclutterMode(styles[0])).toBe('rank')
    expect(getStyleTextDeclutterRank(styles[0])).toBe(9)
    expect(styles[1].getImage()).toBeTruthy()
    expect(styles[2].getImage()).toBeTruthy()
  })

  test('supports conditional expressions, feature view helpers, userdata, constants and scale ranges', async () => {
    const styleFn = await createDynamicStyleFn('conditional', {
      constants: { fallback: '#333333' },
      scales: [100, 1000, 10000],
      static: {
        fill: {
          fill: {
            color: [
              '? F.getId() === "hot" => firstOf(U.mode, "day", "#ff0000", "night", "#0000ff", C.fallback)',
              '? LSCALE === 1000 && USCALE === 10000 => "#00ff00"',
              'default => C.fallback'
            ]
          },
          stroke: {
            width: '=> R + F.getProperties().bonus'
          }
        }
      }
    }, {
      userdata: () => ({ mode: 'day' }),
      scale: () => 5000
    })

    const styles = asStyleArray(styleFn(feature({
      id: 'hot',
      properties: { bonus: 2 },
      geometry: polygonGeometry()
    }), 3))

    expect(styles[0].getFill()?.getColor()).toBe('#ff0000')
    expect(styles[0].getStroke()?.getWidth()).toBe(5)

    const fallbackStyleFn = await createDynamicStyleFn('conditional-fallback', {
      static: {
        fill: {
          fill: {
            color: '=> firstOf(F.get("kind"), "water", "#0000ff")'
          }
        }
      }
    })
    expect(asStyle(fallbackStyleFn(feature({ properties: { kind: 'land' } }), 1)).getFill()?.getColor()).toBeNull()
  })

  test('resolves typed definitions and debug scale logging', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const styleFn = await createDynamicStyleFn('typed-defs', {
      debug: true,
      definitions: {
        stroke: { type: 'Stroke', color: '#223344', width: 4 },
        text: { type: 'Text', text: 'defined', fill: { color: '#000000' } },
        nestedStyle: {
          type: 'Style',
          fill: { color: '#abcdef' },
          zIndex: 12
        },
        passthrough: { type: 'Unknown', color: '#ffffff' }
      },
      scales: [0, 100, 1000],
      static: {
        one: {
          fill: { color: '=> D.nestedStyle.getFill().getColor()' },
          stroke: '=> D.stroke',
          text: '=> D.text',
          zIndex: '=> D.nestedStyle.getZIndex()'
        }
      }
    }, {
      scale: () => 50
    })

    const style = asStyle(styleFn(feature(), 1))
    asStyle(styleFn(feature(), 1))

    expect(style.getFill()?.getColor()).toBe('#abcdef')
    expect(style.getStroke()?.getWidth()).toBe(4)
    expect(style.getText()?.getText()).toBe('defined')
    expect(style.getZIndex()).toBe(12)
    expect(log).toHaveBeenCalledWith('typed-defs', ':', 'current scale range => [0-100]')
    expect(log).toHaveBeenCalledWith('typed-defs', ':', expect.stringContaining('style cached'))

    log.mockRestore()
  })

  test('honors visibility, scale bounds and context scale overrides', async () => {
    const invisible = await createDynamicStyleFn('hidden', { visible: false, static: { one: { fill: { color: 'red' } } } })
    const ranged = await createDynamicStyleFn('ranged', { scales: [100, 200], static: { one: { fill: { color: 'red' } } } })
    const meter = await createDynamicStyleFn('meter', { scales: [0, 100], static: { one: { fill: { color: 'red' } } } }, { units: 'm', dotsPerInch: 1 })
    const degree = await createDynamicStyleFn('degree', { scales: [0, 100], static: { one: { fill: { color: 'red' } } } }, { units: 'dd', dotsPerInch: 1 })

    expect(invisible(feature(), 1)).toBeNull()
    expect(ranged(feature(), 3)).toBeNull()
    expect(ranged(feature(), 150, { scaleDenominator: 150 })).toHaveLength(1)
    expect(meter(feature(), 1, { resolutionByUnit: { m: 1 } })).toHaveLength(1)
    expect(degree(feature(), 0.000001, { resolutionByUnit: { dd: 0.000001 } })).toHaveLength(1)
  })

  test('applies dynamic patches to selected styles and wildcard-compatible nested targets', async () => {
    const styleFn = await createDynamicStyleFn('patched', {
      static: {
        polygon: {
          fill: { color: '#000000' },
          stroke: { color: '#222222', width: 1 },
          text: {
            text: 'before',
            fill: { color: '#111111' },
            stroke: { color: '#eeeeee', width: 1 },
            backgroundStroke: { color: '#cccccc', width: 1 }
          }
        },
        symbol: {
          image: {
            type: 'Circle',
            radius: 4,
            fill: { color: '#333333' },
            stroke: { color: '#444444', width: 1 }
          }
        }
      },
      dynamic: [
        { pointer: '#/polygon/fill/color', value: '=> F.get("fill")' },
        { pointer: '#/polygon/stroke/width', value: '=> SCALE / 100' },
        { pointer: '#/polygon/text/text', value: '=> F.get("label")' },
        { pointer: '#/polygon/text/fill/color', value: '#abcdef' },
        { pointer: '#/polygon/text/backgroundStroke/width', value: 3 },
        { pointer: '#/polygon/text/step', value: 'map' },
        { pointer: '#/polygon/text/declutter', value: 'first' },
        { pointer: '#/polygon/text/rank', value: 4 },
        { pointer: '#/symbol/image/fill/color', value: '#123123' },
        { pointer: '#/*/stroke/color', value: '#654321' }
      ]
    }, {
      scale: () => 200
    })

    const styles = asStyleArray(styleFn(feature({ properties: { fill: '#ff00ff', label: 'after' } }), 1))

    expect(styles[0].getFill()?.getColor()).toBe('#ff00ff')
    expect(styles[0].getStroke()?.getWidth()).toBe(2)
    expect(styles[0].getStroke()?.getColor()).toBe('#654321')
    expect(styles[0].getText()?.getText()).toBe('after')
    expect(styles[0].getText()?.getFill()?.getColor()).toBe('#abcdef')
    expect(styles[0].getText()?.getBackgroundStroke()?.getWidth()).toBe(3)
    expect(getStyleTextRenderStep(styles[0])).toBe('map')
    expect(getStyleTextDeclutterMode(styles[0])).toBe('first')
    expect(getStyleTextDeclutterRank(styles[0])).toBe(4)
  })

  test('handles escaped style names and id lookups in expressions', async () => {
    const styleFn = await createDynamicStyleFn('escaped', {
      static: {
        'a/b': {
          fill: { color: '#000000' },
          text: { text: '=> F.get("id")' }
        }
      },
      dynamic: [
        { pointer: '#/a~1b/fill/color', value: '=> F.get("color")' }
      ]
    })

    const style = asStyle(styleFn(feature({ id: 'from-id', properties: { color: '#123456' } }), 1))

    expect(style.getFill()?.getColor()).toBe('#123456')
    expect(style.getText()?.getText()).toBe('from-id')
  })

  test('covers canvas color fallbacks and canvas setup failures', async () => {
    const noPatternSource = await createDynamicStyleFn('pattern-null', {
      static: {
        one: {
          fill: {
            color: {
              type: 'CanvasPattern'
            }
          }
        }
      }
    })
    expect(asStyle(noPatternSource(feature(), 1)).getFill()?.getColor()).toBeNull()

    const document = globalThis.document
    const gradient = await createDynamicStyleFn('no-document', {
      static: {
        one: {
          fill: {
            color: {
              type: 'LinearGradient',
              x0: 0,
              y0: 0,
              x1: 1,
              y1: 1
            }
          }
        }
      }
    })

    try {
      vi.stubGlobal('document', undefined)
      expect(() => gradient(feature(), 1)).toThrow('canvas-capable document')

      vi.stubGlobal('document', {
        createElement: () => ({
          getContext: () => null
        })
      })
      expect(() => gradient(feature(), 1)).toThrow('Unable to create canvas 2D context')
    } finally {
      vi.stubGlobal('document', document)
    }
  })

  test('normalizes arrays, cache keys, when flags and gradient or pattern colors', async () => {
    const styleFn = await createDynamicStyleFn('normalized', {
      cacheKey: ['same'],
      static: [
        { when: false, fill: { color: 'red' } },
        {
          fill: {
            color: {
              type: 'LinearGradient',
              x0: 0,
              y0: 0,
              x1: 1,
              y1: 1,
              colorStops: [{ offset: 0, color: '#000000' }]
            }
          },
          stroke: {
            color: {
              type: 'RadialGradient',
              x0: 0,
              y0: 0,
              r0: 0,
              x1: 1,
              y1: 1,
              r1: 1
            }
          }
        },
        {
          fill: {
            color: {
              type: 'ConicGradient',
              startAngle: 0,
              x: 1,
              y: 1,
              colorStops: [{ offset: 0, color: '#ffffff' }]
            }
          },
          stroke: {
            color: {
              type: 'CanvasPattern',
              image: { width: 2, height: 2 },
              repetition: 'repeat-x'
            }
          }
        }
      ]
    })

    const first = asStyleArray(styleFn(feature(), 1))
    const second = asStyleArray(styleFn(feature(), 1))

    expect(first).toHaveLength(2)
    expect(second).toBe(first)
    expect(first[0].getFill()?.getColor()).toBeTruthy()
    expect(first[0].getStroke()?.getColor()).toBeTruthy()
    expect(first[1].getFill()?.getColor()).toBeTruthy()
    expect(first[1].getStroke()?.getColor()).toBeTruthy()
  })

  test('normalizes icon sources, SVG strings and image descriptors', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
    const styleFn = await createDynamicStyleFn('icons', {
      static: {
        src: { image: { type: 'Icon', src: svg, scale: 1 } },
        imgString: { image: { type: 'Icon', img: svg, scale: 1 } },
        fallbackDescriptor: { image: { type: 'Icon', img: { width: 8 }, src: 'fallback.png', scale: 1 } }
      }
    })

    const styles = asStyleArray(styleFn(feature(), 1))

    expect(styles).toHaveLength(3)
    for (const style of styles) {
      expect(style.getImage()).toBeTruthy()
    }

    const descriptorFallback = await createDynamicStyleFn('descriptor-fallback', {
      static: {
        icon: { image: { type: 'Icon', img: { src: svg, width: 8, height: 8 } } }
      }
    })
    expect(asStyleArray(descriptorFallback(feature(), 1))[0].getImage()).toBeTruthy()

    const noSizeSvgPath = testTempPath('style-no-size-icon.svg')
    writeFileSync(noSizeSvgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><rect width="14" height="14"/></svg>')
    vi.stubGlobal('Image', CanvasImage)
    const noSizeSvgStyle = await createDynamicStyleFn('descriptor-no-size-svg', {
      static: {
        icon: { image: { type: 'Icon', img: { src: noSizeSvgPath, width: 14, height: 14 } } }
      }
    })
    const noSizeSvgImage = (asStyleArray(noSizeSvgStyle(feature(), 1))[0].getImage() as any).getImage(1)
    expect(noSizeSvgImage).toMatchObject({ width: 14, height: 14 })
    vi.stubGlobal('Image', undefined)

    const missingDescriptorSource = await createDynamicStyleFn('descriptor-missing-source', {
      static: {
        icon: { image: { type: 'Icon', img: { src: 5, width: 8, height: 8 } } }
      }
    })
    expect(() => missingDescriptorSource(feature(), 1)).toThrow('defined and non-empty')

    class TestImage {
      width?: number
      height?: number
      src = ''
    }

    vi.stubGlobal('Image', TestImage)
    const descriptorImage = await createDynamicStyleFn('descriptor-image', {
      static: {
        first: { image: { type: 'Icon', img: { src: 'icon.svg', width: 8, height: 9 } } },
        second: { image: { type: 'Icon', img: { src: 'icon.svg', width: 8, height: 9 } } },
        defaultSize: { image: { type: 'Icon', img: { src: 'default-size.svg' } } }
      }
    })
    const descriptorStyles = asStyleArray(descriptorImage(feature(), 1))

    expect(descriptorStyles).toHaveLength(3)
    expect(descriptorStyles[0].getImage()).toBeTruthy()
    expect(descriptorStyles[1].getImage()).toBeTruthy()
    expect((descriptorStyles[0].getImage() as any).getImage(1)).toMatchObject({ width: 8, height: 9 })
    expect((descriptorStyles[2].getImage() as any).getImage(1)).toMatchObject({ width: 100, height: 100 })
    vi.stubGlobal('Image', undefined)
  })

  test('throws clear errors for invalid dynamic expressions, contexts and patches', async () => {
    await expect(createDynamicStyleFn('bad-conditional', {
      static: { one: { fill: { color: ['not an expression', '? true => "red"'] } } }
    })).rejects.toThrow('Invalid conditional dynamic expression line')

    await expect(createDynamicStyleFn('missing-style', {
      static: { one: { fill: { color: 'red' } } },
      dynamic: [{ pointer: '#/missing/fill/color', value: 'blue' }]
    })).rejects.toThrow('static style "missing" does not exist')

    await expect(createDynamicStyleFn('bad-property', {
      static: { one: { fill: { color: 'red' } } },
      dynamic: [{ pointer: '#/one/fill/width', value: 2 }]
    })).rejects.toThrow('cannot write property "width" on Fill')

    await expect(createDynamicStyleFn('bad-pointer', {
      static: { one: { fill: { color: 'red' } } },
      dynamic: [{ pointer: '/one/fill/color', value: 'blue' }]
    })).rejects.toThrow('expected "#/<style>/<property>"')

    await expect(createDynamicStyleFn('empty-pointer', {
      static: { one: { fill: { color: 'red' } } },
      dynamic: [{ pointer: '#/', value: 'blue' }]
    })).rejects.toThrow('expected "#/<style>/<property>"')

    await expect(createDynamicStyleFn('bad-wildcard', {
      static: {},
      dynamic: [{ pointer: '#/*/fill/color', value: 'blue' }]
    })).rejects.toThrow('static has no styles')

    await expect(createDynamicStyleFn('bad-wildcard-target', {
      static: { one: { stroke: { color: 'red' } } },
      dynamic: [{ pointer: '#/*/fill/color', value: 'blue' }]
    })).rejects.toThrow('does not define "fill"')

    await expect(createDynamicStyleFn('bad-icon-write', {
      static: { one: { image: { type: 'Icon', src: 'icon.png' } } },
      dynamic: [{ pointer: '#/one/image/width', value: 2 }]
    })).rejects.toThrow('cannot write property "width" on Icon')

    await expect(createDynamicStyleFn('bad-circle-write', {
      static: { one: { image: { type: 'Circle', radius: 3 } } },
      dynamic: [{ pointer: '#/one/image/src', value: 'icon.png' }]
    })).rejects.toThrow('cannot write property "src" on Circle')

    await expect(createDynamicStyleFn('bad-shape-write', {
      static: { one: { image: { type: 'RegularShape', points: 3, radius: 4 } } },
      dynamic: [{ pointer: '#/one/image/src', value: 'icon.png' }]
    })).rejects.toThrow('cannot write property "src" on RegularShape')

    await expect(createDynamicStyleFn('bad-text-traverse', {
      static: { one: { text: { text: 'label' } } },
      dynamic: [{ pointer: '#/one/text/image/color', value: 'red' }]
    })).rejects.toThrow('cannot traverse "text/image" from Text')

    await expect(createDynamicStyleFn('bad-empty-expression-key', {
      static: { one: { '': '=> "red"' } }
    })).rejects.toThrow('Invalid dynamic style pointer')

    const dynamic = new DynamicStyle('context', {
      static: { one: { fill: { color: '=> "red"' } } }
    })
    const styleFn = await dynamic.compile()
    await expect(dynamic.compile()).resolves.toEqual(expect.any(Function))
    expect(() => asStyleArray(styleFn(feature(), 1))[0].getFill()?.getColor()).not.toThrow()
  })
})

describe('style registry builder', () => {
  test('registers default, builtin and dynamic styles with generated titles', async () => {
    const dynamicPath = writeTestConfig('styles/roads.json', {
      static: {
        line: {
          stroke: { color: '#999999', width: 3 }
        }
      }
    })

    const registry = await Style.build({
      road_style: {
        type: 'dynamic',
        path: dynamicPath,
        abstract: 'Road drawing'
      }
    })

    expect(registry.get('default').title).toBe('Default')
    expect(registry.get('road_style').title).toBe('Road Style')
    expect(registry.get('road_style').abstract).toBe('Road drawing')
    expect(asStyle(registry.get('road_style').style(feature(), 1)).getStroke()?.getWidth()).toBe(3)
  })

  test('reports unknown builtins and wraps invalid dynamic style load failures', async () => {
    await expect(Style.create('missing', { type: 'builtin' }, validatorNotUsed())).rejects.toThrow('Unknown builtin style "missing"')

    const path = testTempPath('styles/invalid.json')
    writeFileSync(path, '{')
    await expect(Style.build({
      broken: { type: 'dynamic', path }
    })).rejects.toThrow('Invalid dynamic style "broken"')
  })

  test('fails dynamic style loading when a referenced local image is not loadable', async () => {
    const iconPath = testTempPath('styles/no-size.svg')
    writeFileSync(iconPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><rect width="14" height="14"/></svg>')
    const stylePath = writeTestConfig('styles/broken-image-style.json', {
      definitions: {
        icons: {
          school: iconPath
        }
      },
      static: {
        icon: {
          image: {
            type: 'Icon',
            img: {
              src: '=> D.icons.school',
              width: 14,
              height: 14
            }
          }
        }
      }
    })

    await expect(Style.build({
      osmpoi: { type: 'dynamic', path: stylePath }
    })).rejects.toThrow(`image "${iconPath}" is not loadable in dynamic style "osmpoi": width=0 height=0`)
  })
})

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    layer: {} as Feature['layer'],
    type: 'Feature',
    id: 'feature-1',
    properties: {},
    geometry: polygonGeometry(),
    ...overrides
  }
}

function polygonGeometry(): Feature['geometry'] {
  return {
    type: 'Polygon',
    coordinates: polygonCoordinates()
  }
}

function polygonCoordinates(): [[number, number][], ...[number, number][][]] {
  return [[
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0]
    ]]
}

function asStyle(result: StyleResult): OlStyle {
  if (Array.isArray(result)) return result[0]
  if (!result) throw new Error('Expected style result')
  return result
}

function asStyleArray(result: StyleResult): OlStyle[] {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

function validatorNotUsed() {
  return {
    validate() {
      throw new Error('validator should not be used')
    }
  } as never
}
