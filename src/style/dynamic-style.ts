import Fill from 'ol/style/Fill.js'
import Icon from 'ol/style/Icon.js'
import CircleStyle from 'ol/style/Circle.js'
import RegularShape from 'ol/style/RegularShape.js'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import Text from 'ol/style/Text.js'
import type { Feature } from '../core/feature.js'
import type { StyleContext, StyleFn } from './style-fn.js'
import { DefsSolver } from '../config/defs-solver.js'
import {
  setTextDeclutterMode,
  setTextDeclutterRank,
  setTextRenderStep
} from './text-render-step.js'
import { Props } from '../core/tools.js'

type JsonObject = Props
type DynamicExpression = string | string[]
type DynamicExpressionGetter = () => unknown
type StyleOptions = ConstructorParameters<typeof Style>[0]
type FillOptions = ConstructorParameters<typeof Fill>[0]
type StrokeOptions = ConstructorParameters<typeof Stroke>[0]
type IconOptions = ConstructorParameters<typeof Icon>[0]
type RegularShapeOptions = ConstructorParameters<typeof RegularShape>[0]
type CircleOptions = ConstructorParameters<typeof CircleStyle>[0]
type TextOptions = ConstructorParameters<typeof Text>[0]
type ImageSourceSize = { width?: number, height?: number }

export type DynamicStyleJson = {
  $schema?: string
  $defs?: JsonObject
  constants?: JsonObject
  definitions?: JsonObject
  debug?: boolean
  format?: string
  group?: string
  title?: string
  id?: string | null
  crs?: string
  scales?: number[]
  cacheKey?: unknown
  visible?: boolean
  static?: JsonObject | JsonObject[]
  dynamic?: DynamicStylePatch[]
}

export type DynamicStylePatch = {
  pointer: string
  value: unknown
}

export type DynamicStyleOptions = {
  userdata?: () => unknown
  units?: 'm' | 'dd'
  dotsPerInch?: number
  scale?: (feature: Feature, resolution: number, context?: StyleContext) => number
}

type DynamicStyleContext = {
  feature: FeatureView
  resolution: number
  scale: number
  lowerScale: number
  upperScale: number
  definitions: JsonObject
  constants: JsonObject
  userdata: unknown
}

type NormalizedDynamicStyleJson = Required<Omit<DynamicStyleJson, '$defs'>>

const INCHES_PER_UNIT = {
  m: 39.37,
  dd: 4374754
}

const STYLE_NAME = Symbol('dynamicStyleName')

type DynamicPatchTargetKind = 'style' | 'fill' | 'stroke' | 'text' | 'icon' | 'circle' | 'regularShape' | 'image'

type DynamicPatchTarget = {
  kind: DynamicPatchTargetKind
  description: unknown
  unknown: boolean
}

type DynamicPatchValidationResult = {
  valid: true
} | {
  valid: false
  optional: boolean
  reason: string
}

const STYLE_WRITABLE_PROPERTIES = new Set([
  'geometry',
  'fill',
  'image',
  'renderer',
  'hitDetectionRenderer',
  'stroke',
  'text',
  'zIndex'
])
const FILL_WRITABLE_PROPERTIES = new Set(['color'])
const STROKE_WRITABLE_PROPERTIES = new Set([
  'color',
  'lineCap',
  'lineDash',
  'lineDashOffset',
  'lineJoin',
  'miterLimit',
  'offset',
  'width'
])
const TEXT_WRITABLE_PROPERTIES = new Set([
  'step',
  'declutter',
  'rank',
  'font',
  'maxAngle',
  'offsetX',
  'offsetY',
  'overflow',
  'placement',
  'repeat',
  'rotateWithView',
  'keepUpright',
  'fill',
  'rotation',
  'scale',
  'stroke',
  'text',
  'textAlign',
  'justify',
  'textBaseline',
  'backgroundFill',
  'backgroundStroke',
  'padding',
  'declutterMode'
])
const ICON_WRITABLE_PROPERTIES = new Set([
  'anchor',
  'color',
  'src',
  'displacement',
  'opacity',
  'rotateWithView',
  'rotation',
  'scale'
])
const SHAPE_WRITABLE_PROPERTIES = new Set([
  'fill',
  'radius',
  'radius2',
  'stroke',
  'displacement',
  'opacity',
  'rotateWithView',
  'rotation',
  'scale'
])
const IMAGE_WRITABLE_PROPERTIES = new Set([
  ...ICON_WRITABLE_PROPERTIES,
  ...SHAPE_WRITABLE_PROPERTIES
])

let layerCount = 0

export async function createDynamicStyleFn(
  name: string,
  jsonStyle: DynamicStyleJson,
  options: DynamicStyleOptions = {}
): Promise<StyleFn> {
  return new DynamicStyle(name, jsonStyle, options).compile()
}

export class DynamicStyle {
  private readonly jsonStyle: NormalizedDynamicStyleJson
  private readonly cache = new Map<string, Style[]>()
  private readonly iconOptionsNormalizer = new DynamicIconOptionsNormalizer()
  private readonly userdata: () => unknown
  private readonly units: 'm' | 'dd'
  private readonly dotsPerInch: number
  private readonly scaleOverride?: (feature: Feature, resolution: number, context?: StyleContext) => number
  private context: DynamicStyleContext | null = null
  private lastScaleRange: [number | undefined, number | undefined] = [undefined, undefined]
  private compiled = false

  constructor(
    private readonly name: string = `LAYER${++layerCount}`,
    jsonStyle: DynamicStyleJson,
    options: DynamicStyleOptions = {}
  ) {
    this.jsonStyle = normalizeStyleJson(jsonStyle, this.name)
    this.userdata = options.userdata ?? (() => ({}))
    this.units = options.units ?? 'm'
    this.dotsPerInch = options.dotsPerInch ?? 90
    this.scaleOverride = options.scale
  }

  async compile(): Promise<StyleFn> {
    if (!this.compiled) {
      this.validateDynamicPatches()
      this.compileExpressions()
      this.compileDefinitions()
      this.compiled = true
    }

    return (feature, resolution, context) => this.resolve(feature, resolution, context)
  }

  private resolve(feature: Feature, resolution: number, context?: StyleContext): Style[] | null {
    if (!this.jsonStyle.visible) return null

    const scale = this.scale(feature, resolution, context)
    if (scale < this.minscale || scale >= this.maxscale) return null

    this.setContext(feature, resolution, scale)
    this.logScaleRange()

    const cacheKey = this.cacheKey()
    let styles = this.cache.get(cacheKey)

    if (!styles) {
      styles = this.createStyles()
      this.cache.set(cacheKey, styles)
      this.log(`style cached [${cacheKey}] => (${styles.map((style) => getStyleName(style)).join('/')})`)
    }

    this.applyDynamicPatches(styles)
    return styles.length > 0 ? styles : null
  }

  private get minscale(): number {
    return this.jsonStyle.scales[0] ?? 0
  }

  private get maxscale(): number {
    return this.jsonStyle.scales[this.jsonStyle.scales.length - 1] ?? Number.POSITIVE_INFINITY
  }

  private get constants(): JsonObject {
    return this.jsonStyle.constants
  }

  private get definitions(): JsonObject {
    return this.jsonStyle.definitions
  }

  private setContext(feature: Feature, resolution: number, scale: number): void {
    const [lowerScale, upperScale] = this.rangeScale(scale)

    this.context = {
      feature: new FeatureView(feature),
      resolution,
      scale,
      lowerScale,
      upperScale,
      definitions: this.definitions,
      constants: this.constants,
      userdata: this.userdata()
    }
  }

  private scale(feature: Feature, resolution: number, context?: StyleContext): number {
    if (this.scaleOverride) return this.scaleOverride(feature, resolution, context)
    if (context?.scaleDenominator !== undefined) return context.scaleDenominator

    const unitResolution = context?.resolutionByUnit?.[this.units] ?? resolution
    return INCHES_PER_UNIT[this.units] * this.dotsPerInch * unitResolution
  }

  private rangeScale(mapscale: number): [number, number] {
    let lowerScale = this.minscale

    for (const scale of this.jsonStyle.scales) {
      if (mapscale > scale) {
        lowerScale = scale
        continue
      }

      return [lowerScale, scale]
    }

    return [lowerScale, this.maxscale]
  }

  private cacheKey(): string {
    const value = this.jsonStyle.cacheKey
    return Array.isArray(value) || isPlainObject(value)
      ? JSON.stringify(value)
      : String(value)
  }

  private createStyles(): Style[] {
    const styles: Style[] = []

    for (const [styleName, styleDescription] of this.staticStyleEntries()) {
      if (styleDescription.when === false) continue

      const fill = this.createFill(styleDescription.fill)
      const stroke = this.createStroke(styleDescription.stroke)
      const image = this.createImage(styleDescription.image)
      const text = this.createText(styleDescription.text)
      const zIndex = typeof styleDescription.zIndex === 'number' ? styleDescription.zIndex : undefined

      const style = new Style({
        fill: fill ?? undefined,
        stroke: stroke ?? undefined,
        image: image ?? undefined,
        text: text ?? undefined,
        zIndex
      } as StyleOptions)
      setStyleName(style, styleName)
      styles.push(style)
    }

    return styles
  }

  private staticStyleEntries(): Array<[string, JsonObject]> {
    const staticStyles = this.jsonStyle.static

    if (Array.isArray(staticStyles)) {
      return staticStyles
        .filter(isPlainObject)
        .map((styleDescription, index) => [String(index), styleDescription])
    }

    return Object.entries(staticStyles)
      .filter((entry): entry is [string, JsonObject] => isPlainObject(entry[1]))
  }

  private validateDynamicPatches(): void {
    new DynamicPatchValidator(this.name, this.staticStyleEntries(), this.jsonStyle.dynamic).validate()
  }

  private compileExpressions(): void {
    const expressions = collectExpressions(this.jsonStyle)

    for (const [pointer, expression] of expressions) {
      const [base, key] = this.deref(pointer)
      const compiled = compileExpression(expression, this.name, pointer)

      Object.defineProperty(base, key, {
        configurable: true,
        enumerable: true,
        get: () => this.evaluate(compiled)
      })
    }
  }

  private compileDefinitions(): void {
    for (const key of Object.keys(this.definitions)) {
      const descriptor = Object.getOwnPropertyDescriptor(this.definitions, key)
      if (descriptor?.get) continue

      const value = this.definitions[key]
      if (!isPlainObject(value) || typeof value.type !== 'string') continue

      Object.defineProperty(this.definitions, key, {
        configurable: true,
        enumerable: true,
        get: () => this.createTypedStylePart(value)
      })
    }
  }

  private evaluate(getter: DynamicExpressionGetter): unknown {
    if (!this.context) {
      throw new Error('Dynamic style expression evaluated without render context')
    }

    return getter.call(this.context)
  }

  private deref(pointer: string): [JsonObject, string] {
    let base: unknown = this.jsonStyle
    const keys = pointer.replace(/^\/+/, '').split('/').map(unescapeJsonPointer)
    const key = keys.pop()

    if (!key) {
      throw new Error(`Invalid dynamic style pointer: ${pointer}`)
    }

    for (const part of keys) {
      if (!isPlainObject(base) && !Array.isArray(base)) {
        throw new Error(`Invalid dynamic style pointer: ${pointer}`)
      }

      base = (base as Props)[part]
    }

    if (!isPlainObject(base) && !Array.isArray(base)) {
      throw new Error(`Invalid dynamic style pointer: ${pointer}`)
    }

    return [base as JsonObject, key]
  }

  private applyDynamicPatches(styles: Style[]): void {
    for (const patch of this.jsonStyle.dynamic) {
      if (!patch.pointer.startsWith('#/')) continue

      const segments = patch.pointer
        .slice(2)
        .split('/')
        .map(unescapeJsonPointer)

      const styleSelector = segments.shift()
      const property = segments.pop()

      if (!styleSelector || !property) continue

      for (const style of styles) {
        if (styleSelector !== '*' && getStyleName(style) !== styleSelector) continue

        const target = resolveStyleTarget(style, segments)
        if (!target) continue

        writeStyleProperty(target, property, patch.value)
      }
    }
  }

  private createTypedStylePart(description: JsonObject): unknown {
    switch (description.type) {
      case 'Fill':
        return this.createFill(description)
      case 'Stroke':
        return this.createStroke(description)
      case 'Icon':
        return this.createIcon(description)
      case 'RegularShape':
        return this.createRegularShape(description)
      case 'Circle':
        return this.createCircle(description)
      case 'Text':
        return this.createText(description)
      case 'Style':
        return this.createStyle(description)
      default:
        return description
    }
  }

  private createStyle(description: unknown): Style | null {
    if (description instanceof Style) return description
    if (!isPlainObject(description)) return null
    if (description.when === false) return null

    const fill = this.createFill(description.fill)
    const stroke = this.createStroke(description.stroke)
    const image = this.createImage(description.image)
    const text = this.createText(description.text)

    return new Style({
      fill: fill ?? undefined,
      stroke: stroke ?? undefined,
      image: image ?? undefined,
      text: text ?? undefined,
      zIndex: typeof description.zIndex === 'number' ? description.zIndex : undefined
    } as StyleOptions)
  }

  private createFill(description: unknown): Fill | null {
    if (description == null || description === false) return null
    if (description instanceof Fill) return description
    if (!isPlainObject(description)) return null

    const options = copyOptions(description)
    if (options.when === false) return null

    delete options.type
    delete options.when
    this.applyColorOption(options, 'color')

    return new Fill(options as FillOptions)
  }

  private createStroke(description: unknown): Stroke | null {
    if (description == null || description === false) return null
    if (description instanceof Stroke) return description
    if (!isPlainObject(description)) return null

    const options = copyOptions(description)
    if (options.when === false) return null

    delete options.type
    delete options.when
    this.applyColorOption(options, 'color')

    return new Stroke(options as StrokeOptions)
  }

  private createImage(description: unknown): Icon | RegularShape | CircleStyle | null {
    if (description == null || description === false) return null
    if (description instanceof Icon || description instanceof RegularShape || description instanceof CircleStyle) {
      return description
    }
    if (!isPlainObject(description)) return null

    if (description.when === false) return null
    if (description.type === 'Icon' || description.src != null || description.img != null) {
      return this.createIcon(description)
    }
    if (description.type === 'RegularShape' || description.points != null) {
      return this.createRegularShape(description)
    }
    if (description.type === 'Circle' || description.radius != null) {
      return this.createCircle(description)
    }

    return null
  }

  private createIcon(description: unknown): Icon | null {
    if (description == null || description === false) return null
    if (description instanceof Icon) return description
    if (!isPlainObject(description)) return null

    const options = copyOptions(description)
    if (options.when === false) return null

    delete options.type
    delete options.when
    this.applyColorOption(options, 'color')
    this.iconOptionsNormalizer.normalize(options)

    return new Icon(options as IconOptions)
  }

  private createRegularShape(description: unknown): RegularShape | null {
    if (description == null || description === false) return null
    if (description instanceof RegularShape) return description
    if (!isPlainObject(description)) return null

    const options = copyOptions(description)
    if (options.when === false) return null

    delete options.type
    delete options.when
    options.fill = this.createFill(options.fill)
    options.stroke = this.createStroke(options.stroke)

    return new RegularShape(options as RegularShapeOptions)
  }

  private createCircle(description: unknown): CircleStyle | null {
    if (description == null || description === false) return null
    if (description instanceof CircleStyle) return description
    if (!isPlainObject(description)) return null

    const options = copyOptions(description)
    if (options.when === false) return null

    delete options.type
    delete options.when
    options.fill = this.createFill(options.fill)
    options.stroke = this.createStroke(options.stroke)

    return new CircleStyle(options as CircleOptions)
  }

  private createText(description: unknown): Text | null {
    if (description == null || description === false) return null
    if (description instanceof Text) return description
    if (!isPlainObject(description)) return null

    const options = copyOptions(description)
    if (options.when === false) return null

    const step = options.step
    const declutter = options.declutter
    const rank = options.rank
    delete options.type
    delete options.when
    delete options.step
    delete options.declutter
    delete options.rank

    if (options.fill == null && options.color != null) {
      options.fill = { color: options.color }
    }

    delete options.color
    options.fill = this.createFill(options.fill)
    options.stroke = this.createStroke(options.stroke)
    options.backgroundFill = this.createFill(options.backgroundFill)
    options.backgroundStroke = this.createStroke(options.backgroundStroke)

    const text = new Text(options as TextOptions)
    setTextRenderStep(text, step)
    setTextDeclutterMode(text, declutter)
    setTextDeclutterRank(text, rank)
    return text
  }

  private applyColorOption(options: JsonObject, property: string): void {
    const color = options[property]
    if (!isPlainObject(color) || typeof color.type !== 'string') return

    switch (color.type) {
      case 'LinearGradient':
        options[property] = createLinearGradient(color)
        return
      case 'RadialGradient':
        options[property] = createRadialGradient(color)
        return
      case 'ConicGradient':
        options[property] = createConicGradient(color)
        return
      case 'CanvasPattern':
        options[property] = createCanvasPattern(color)
    }
  }

  private logScaleRange(): void {
    if (!this.context) return

    const nextRange: [number | undefined, number | undefined] = [
      this.context.lowerScale,
      this.context.upperScale
    ]

    if (this.lastScaleRange[0] === nextRange[0] && this.lastScaleRange[1] === nextRange[1]) {
      return
    }

    this.lastScaleRange = nextRange
    this.log(`current scale range => [${nextRange.join('-')}]`)
  }

  private log(message: string): void {
    if (this.jsonStyle.debug) {
      console.log(this.name, ':', message)
    }
  }
}

class FeatureView {
  readonly id: Feature['id']
  readonly properties: Feature['properties']
  readonly geometry: Feature['geometry']
  readonly bbox: Feature['bbox']
  readonly crs: Feature['crs']
  readonly sourceRef: Feature['sourceRef']

  constructor(readonly raw: Feature) {
    this.id = raw.id
    this.properties = raw.properties
    this.geometry = raw.geometry
    this.bbox = raw.bbox
    this.crs = raw.crs
    this.sourceRef = raw.sourceRef
  }

  get(property: string): unknown {
    if (property === 'id') return this.id
    return this.properties?.[property]
  }

  getId(): Feature['id'] {
    return this.id
  }

  getProperties(): Feature['properties'] {
    return this.properties
  }
}

class DynamicPatchValidator {
  constructor(
    private readonly styleName: string,
    private readonly staticStyles: Array<[string, JsonObject]>,
    private readonly patches: DynamicStylePatch[]
  ) {}

  validate(): void {
    for (const patch of this.patches) {
      this.validatePatch(patch)
    }
  }

  private validatePatch(patch: DynamicStylePatch): void {
    const { styleSelector, path, property } = this.parsePointer(patch.pointer)

    if (styleSelector === '*') {
      this.validateWildcardPatch(patch.pointer, path, property)
      return
    }

    const styleDescription = this.staticStyles.find(([name]) => name === styleSelector)?.[1]
    if (!styleDescription) {
      throw new Error(
        `Invalid dynamic style "${this.styleName}" patch "${patch.pointer}": static style "${styleSelector}" does not exist`
      )
    }

    const result = this.validatePath(styleSelector, styleDescription, path, property)
    if (!result.valid) {
      throw new Error(`Invalid dynamic style "${this.styleName}" patch "${patch.pointer}": ${result.reason}`)
    }
  }

  private validateWildcardPatch(pointer: string, path: string[], property: string): void {
    if (this.staticStyles.length === 0) {
      throw new Error(`Invalid dynamic style "${this.styleName}" patch "${pointer}": static has no styles`)
    }

    const results = this.staticStyles.map(([name, styleDescription]) => (
      this.validatePath(name, styleDescription, path, property)
    ))
    const invalid = results.find((result) => !result.valid && !result.optional)
    if (invalid && !invalid.valid) {
      throw new Error(`Invalid dynamic style "${this.styleName}" patch "${pointer}": ${invalid.reason}`)
    }

    if (!results.some((result) => result.valid)) {
      const reason = results.find((result) => !result.valid)?.reason ?? 'no static style matches this pointer'
      throw new Error(`Invalid dynamic style "${this.styleName}" patch "${pointer}": ${reason}`)
    }
  }

  private parsePointer(pointer: string): { styleSelector: string, path: string[], property: string } {
    if (!pointer.startsWith('#/')) {
      throw new Error(`Invalid dynamic style "${this.styleName}" patch pointer "${pointer}": expected "#/<style>/<property>"`)
    }

    const segments = pointer
      .slice(2)
      .split('/')
      .map(unescapeJsonPointer)
    const styleSelector = segments.shift()
    const property = segments.pop()

    if (!styleSelector || !property) {
      throw new Error(`Invalid dynamic style "${this.styleName}" patch pointer "${pointer}": expected "#/<style>/<property>"`)
    }

    return { styleSelector, path: segments, property }
  }

  private validatePath(
    styleName: string,
    styleDescription: JsonObject,
    path: string[],
    property: string
  ): DynamicPatchValidationResult {
    let target: DynamicPatchTarget = {
      kind: 'style',
      description: styleDescription,
      unknown: false
    }
    const currentPath: string[] = []

    for (const segment of path) {
      currentPath.push(segment)
      const childKind = this.childKind(target.kind, segment)

      if (!childKind) {
        return this.invalid(
          true,
          `cannot traverse "${currentPath.join('/')}" from ${this.kindLabel(target.kind)}`
        )
      }

      const child = this.childTarget(target, segment, childKind)
      if (!child.valid) {
        return this.invalid(
          true,
          `static style "${styleName}" does not define "${currentPath.join('/')}"`
        )
      }

      target = child.target
    }

    if (!this.canWrite(target.kind, property)) {
      return this.invalid(false, `cannot write property "${property}" on ${this.kindLabel(target.kind)}`)
    }

    return { valid: true }
  }

  private childTarget(
    target: DynamicPatchTarget,
    segment: string,
    childKind: DynamicPatchTargetKind
  ): { valid: true, target: DynamicPatchTarget } | { valid: false } {
    if (target.unknown || isDynamicExpression(target.description)) {
      return {
        valid: true,
        target: {
          kind: childKind,
          description: undefined,
          unknown: true
        }
      }
    }

    if (!isPlainObject(target.description) || !(segment in target.description)) {
      return { valid: false }
    }

    const description = target.description[segment]
    if (description === null || description === false) {
      return { valid: false }
    }

    return {
      valid: true,
      target: {
        kind: this.inferKind(childKind, description),
        description,
        unknown: isDynamicExpression(description)
      }
    }
  }

  private childKind(kind: DynamicPatchTargetKind, property: string): DynamicPatchTargetKind | null {
    if (kind === 'style') {
      return this.styleChildKind(property)
    }

    if (kind === 'text') {
      return this.textChildKind(property)
    }

    if (kind === 'circle' || kind === 'regularShape' || kind === 'image') {
      return this.shapeChildKind(property)
    }

    return null
  }

  private styleChildKind(property: string): DynamicPatchTargetKind | null {
    switch (property) {
      case 'fill':
        return 'fill'
      case 'stroke':
        return 'stroke'
      case 'image':
        return 'image'
      case 'text':
        return 'text'
      default:
        return null
    }
  }

  private textChildKind(property: string): DynamicPatchTargetKind | null {
    switch (property) {
      case 'fill':
      case 'backgroundFill':
        return 'fill'
      case 'stroke':
      case 'backgroundStroke':
        return 'stroke'
      default:
        return null
    }
  }

  private shapeChildKind(property: string): DynamicPatchTargetKind | null {
    switch (property) {
      case 'fill':
        return 'fill'
      case 'stroke':
        return 'stroke'
      default:
        return null
    }
  }

  private inferKind(expectedKind: DynamicPatchTargetKind, description: unknown): DynamicPatchTargetKind {
    if (expectedKind !== 'image' || !isPlainObject(description)) {
      return expectedKind
    }

    if (description.type === 'Icon' || description.src != null || description.img != null) {
      return 'icon'
    }

    if (description.type === 'RegularShape' || description.points != null) {
      return 'regularShape'
    }

    if (description.type === 'Circle' || description.radius != null) {
      return 'circle'
    }

    return 'image'
  }

  private canWrite(kind: DynamicPatchTargetKind, property: string): boolean {
    switch (kind) {
      case 'style':
        return STYLE_WRITABLE_PROPERTIES.has(property)
      case 'fill':
        return FILL_WRITABLE_PROPERTIES.has(property)
      case 'stroke':
        return STROKE_WRITABLE_PROPERTIES.has(property)
      case 'text':
        return TEXT_WRITABLE_PROPERTIES.has(property)
      case 'icon':
        return ICON_WRITABLE_PROPERTIES.has(property)
      case 'circle':
      case 'regularShape':
        return SHAPE_WRITABLE_PROPERTIES.has(property)
      case 'image':
        return IMAGE_WRITABLE_PROPERTIES.has(property)
    }
  }

  private kindLabel(kind: DynamicPatchTargetKind): string {
    switch (kind) {
      case 'style':
        return 'Style'
      case 'fill':
        return 'Fill'
      case 'stroke':
        return 'Stroke'
      case 'text':
        return 'Text'
      case 'icon':
        return 'Icon'
      case 'circle':
        return 'Circle'
      case 'regularShape':
        return 'RegularShape'
      case 'image':
        return 'Image'
    }
  }

  private invalid(optional: boolean, reason: string): DynamicPatchValidationResult {
    return {
      valid: false,
      optional,
      reason
    }
  }
}

function normalizeStyleJson(jsonStyle: DynamicStyleJson, name: string): NormalizedDynamicStyleJson {
  const resolved = new DefsSolver('dynamic style').solve(jsonStyle, `dynamic style "${name}"`)
  const cloned = deepClone(resolved)
  const normalized: NormalizedDynamicStyleJson = {
    $schema: cloned.$schema ?? '',
    constants: isPlainObject(cloned.constants) ? cloned.constants : {},
    definitions: isPlainObject(cloned.definitions) ? cloned.definitions : {},
    debug: cloned.debug ?? false,
    format: cloned.format ?? 'geojson',
    group: cloned.group ?? name,
    title: cloned.title ?? `Layer ${name}`,
    id: cloned.id ?? null,
    crs: cloned.crs ?? 'EPSG:4326',
    scales: [...(cloned.scales ?? [])].sort((a, b) => a - b),
    cacheKey: cloned.cacheKey ?? 'DEFAULT',
    visible: cloned.visible ?? true,
    static: normalizeStaticStyles(cloned.static),
    dynamic: Array.isArray(cloned.dynamic) ? cloned.dynamic : []
  }

  for (const styleDescription of Object.values(normalized.static)) {
    if (!isPlainObject(styleDescription)) continue

    styleDescription.when ??= '=> true'

    for (const value of Object.values(styleDescription)) {
      if (isPlainObject(value)) {
        value.when ??= '=> true'
      }
    }
  }

  return normalized
}

function normalizeStaticStyles(staticStyles: unknown): JsonObject {
  if (Array.isArray(staticStyles)) {
    return Object.fromEntries(
      staticStyles
        .filter(isPlainObject)
        .map((styleDescription, index) => [String(index), styleDescription])
    )
  }

  return isPlainObject(staticStyles) ? staticStyles : {}
}

function collectExpressions(value: unknown, pointer = '', expressions: Array<[string, DynamicExpression]> = []): Array<[string, DynamicExpression]> {
  if (isDynamicExpression(value)) {
    expressions.push([pointer, value])
    return expressions
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExpressions(item, `${pointer}/${index}`, expressions))
    return expressions
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectExpressions(item, `${pointer}/${escapeJsonPointer(key)}`, expressions)
    }
  }

  return expressions
}

function isDynamicExpression(value: unknown): value is DynamicExpression {
  if (typeof value === 'string') return value.trimStart().startsWith('=>')
  return Array.isArray(value) && value.every((item) => typeof item === 'string') && value.some(isConditionalExpressionLine)
}

function isConditionalExpressionLine(value: string): boolean {
  const line = value.trimStart()
  return line.startsWith('?') || /^default\s*=>/.test(line)
}

function compileExpression(expression: DynamicExpression, layerName: string, pointer: string): DynamicExpressionGetter {
  const source = Array.isArray(expression)
    ? conditionalExpressionToSource(expression)
    : singleExpressionToSource(expression)

  const sourceUrl = `dynamic/${layerName}${pointer.replace(/[^A-Z0-9a-z]+/g, '_')}.js`
  const factory = new Function('firstOf', `
    return function dynamicExpression() {
      const F = this.feature
      const R = this.resolution
      const SCALE = this.scale
      const LSCALE = this.lowerScale
      const USCALE = this.upperScale
      const D = this.definitions
      const C = this.constants
      const U = this.userdata
      ${source}
    }
    //# sourceURL=${sourceUrl}
  `)

  return factory(firstOf) as DynamicExpressionGetter
}

function singleExpressionToSource(expression: string): string {
  const body = expression.trimStart().slice(2).trim()
  return body.startsWith('{') ? body : `return (${body})`
}

function conditionalExpressionToSource(expression: string[]): string {
  const lines = expression.map((line) => line.trim()).filter(Boolean)

  return lines.map((line) => {
    const defaultMatch = /^default\s*=>(.*)$/s.exec(line)
    if (defaultMatch) {
      return `return (${defaultMatch[1].trim()})`
    }

    const conditionalMatch = /^\?(.*?)=>(.*)$/s.exec(line)
    if (conditionalMatch) {
      return `if (${conditionalMatch[1].trim()}) return (${conditionalMatch[2].trim()})`
    }

    throw new Error(`Invalid conditional dynamic expression line: ${line}`)
  }).join('\n')
}

function firstOf<T>(selectedValue: unknown, ...args: unknown[]): T | null {
  const defaultValue = args.length > 0 && args.length % 2 === 1 ? args.pop() as T : null

  for (let index = 0; index < args.length; index += 2) {
    if (selectedValue === args[index]) return args[index + 1] as T
  }

  return defaultValue
}

function resolveStyleTarget(style: Style, path: string[]): unknown {
  let current: unknown = style

  for (const property of path) {
    if (current == null) return null
    current = readStyleProperty(current, property)
  }

  return current
}

function readStyleProperty(target: unknown, property: string): unknown {
  if (!isObject(target)) return null

  const getter = `get${capitalize(property)}`
  const candidate = (target as Props)[getter]

  if (typeof candidate === 'function') {
    return candidate.call(target)
  }

  return (target as Props)[property]
}

function writeStyleProperty(target: unknown, property: string, value: unknown): void {
  if (!isObject(target)) return

  if (target instanceof Text && property === 'step') {
    setTextRenderStep(target, value)
    return
  }

  if (target instanceof Text && property === 'declutter') {
    setTextDeclutterMode(target, value)
    return
  }

  if (target instanceof Text && property === 'rank') {
    setTextDeclutterRank(target, value)
    return
  }

  const setter = `set${capitalize(property)}`
  const candidate = (target as Props)[setter]

  if (typeof candidate === 'function') {
    candidate.call(target, value)
    return
  }

  ;(target as Props)[property] = value
}

function createLinearGradient(description: JsonObject): CanvasGradient {
  const context = createCanvasContext()
  const gradient = context.createLinearGradient(
    asNumber(description.x0),
    asNumber(description.y0),
    asNumber(description.x1),
    asNumber(description.y1)
  )

  addColorStops(gradient, description.colorStops)
  return gradient
}

function createRadialGradient(description: JsonObject): CanvasGradient {
  const context = createCanvasContext()
  const gradient = context.createRadialGradient(
    asNumber(description.x0),
    asNumber(description.y0),
    asNumber(description.r0),
    asNumber(description.x1),
    asNumber(description.y1),
    asNumber(description.r1)
  )

  addColorStops(gradient, description.colorStops)
  return gradient
}

function createConicGradient(description: JsonObject): CanvasGradient {
  const context = createCanvasContext()
  const gradient = context.createConicGradient(
    asNumber(description.startAngle),
    asNumber(description.x),
    asNumber(description.y)
  )

  addColorStops(gradient, description.colorStops)
  return gradient
}

function createCanvasPattern(description: JsonObject): CanvasPattern | null {
  const context = createCanvasContext()
  const source = description.image ?? description.img
  const image = createImageSource(source)

  if (!image) return null
  return context.createPattern(image, (typeof description.repetition === 'string' ? description.repetition : 'repeat'))
}

function addColorStops(gradient: CanvasGradient, colorStops: unknown): void {
  if (!Array.isArray(colorStops)) return

  for (const colorStop of colorStops) {
    if (!isPlainObject(colorStop)) continue
    gradient.addColorStop(asNumber(colorStop.offset), String(colorStop.color))
  }
}

function createCanvasContext(): CanvasRenderingContext2D {
  const documentLike = globalThis.document
  if (!documentLike?.createElement) {
    throw new Error('Dynamic canvas colors require a canvas-capable document implementation')
  }

  const canvas = documentLike.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to create canvas 2D context')

  return context
}

function createImageSource(source: unknown, size?: ImageSourceSize): CanvasImageSource | null {
  if (source == null) return null
  if (typeof source !== 'string') return source as CanvasImageSource

  const ImageConstructor = globalThis.Image
  if (!ImageConstructor) {
    throw new Error('Dynamic image styles require a global Image implementation')
  }

  const image = new ImageConstructor()
  applyImageSourceSize(image, size)
  image.src = source.trimStart().startsWith('<svg') ? svgDataUrl(source) : source
  applyImageSourceSize(image, size)

  return image as unknown as CanvasImageSource
}

class DynamicIconOptionsNormalizer {
  private readonly images = new Map<string, CanvasImageSource>()

  normalize(options: JsonObject): void {
    const imageSource = options.img

    if (isIconImageDescriptor(imageSource)) {
      this.normalizeImageDescriptor(options, imageSource)
    } else if (typeof imageSource === 'string') {
      options.src = this.sourceUrl(imageSource)
      delete options.img
    } else if (typeof options.src === 'string') {
      options.src = this.sourceUrl(options.src)
    }
  }

  private normalizeImageDescriptor(options: JsonObject, descriptor: JsonObject): void {
    const source = descriptor.src
    if (typeof source !== 'string') {
      delete options.img
      return
    }

    const size = imageSourceSize(descriptor)
    const image = this.image(source, size)
    if (image) {
      options.img = image
      delete options.src
      return
    }

    options.src = this.sourceUrl(source)
    delete options.img
  }

  private image(source: string, size?: ImageSourceSize): CanvasImageSource | null {
    const url = this.sourceUrl(source)
    const cacheKey = this.cacheKey(url, size)
    const cached = this.images.get(cacheKey)
    if (cached) return cached

    try {
      const image = createImageSource(source, size)
      if (!image) return null

      this.images.set(cacheKey, image)
      return image
    } catch {
      return null
    }
  }

  private sourceUrl(source: string): string {
    return source.trimStart().startsWith('<svg') ? svgDataUrl(source) : source
  }

  private cacheKey(url: string, size?: ImageSourceSize): string {
    return `${url}\u0000${size?.width ?? ''}\u0000${size?.height ?? ''}`
  }
}

function isIconImageDescriptor(value: unknown): value is JsonObject {
  if (!isPlainObject(value)) return false

  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && 'src' in value
}

function imageSourceSize(descriptor: JsonObject): ImageSourceSize | undefined {
  const width = typeof descriptor.width === 'number' ? descriptor.width : undefined
  const height = typeof descriptor.height === 'number' ? descriptor.height : undefined

  return width === undefined && height === undefined ? undefined : { width, height }
}

function applyImageSourceSize(image: unknown, size?: ImageSourceSize): void {
  if (!size) return

  const target = image as { width?: number, height?: number }
  if (size.width !== undefined) target.width = size.width
  if (size.height !== undefined) target.height = size.height
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function setStyleName(style: Style, name: string): void {
  ;(style as Style & { [STYLE_NAME]?: string })[STYLE_NAME] = name
}

function getStyleName(style: Style): string | undefined {
  return (style as Style & { [STYLE_NAME]?: string })[STYLE_NAME]
}

function copyOptions(description: JsonObject): JsonObject {
  return Object.assign({}, description)
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unescapeJsonPointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~')
}

function isPlainObject(value: unknown): value is JsonObject {
  return isObject(value) && !Array.isArray(value)
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
