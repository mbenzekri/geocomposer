import { Image as CanvasImage } from 'canvas'
import type { DescInfo, RegistryEntry } from '../core/feature.js'
import { JsonValidator } from '../core/json-validator.js'
import { Dict, isPlainObject, Registry } from '../core/tools.js'
import { DefsSolver } from '../config/defs-solver.js'
import { createDynamicStyleFn, type DynamicStyleJson } from './dynamic-style.js'
import { defaultStyleFn } from './default-style.js'
import type { StyleFn } from './style-fn.js'
import dynamicStyleSchema from './dynstyle.schema.json' with { type: 'json' }

const BUILTIN_STYLES: Dict<StyleFn> = {
  default: defaultStyleFn
}

export type NamedStyle = RegistryEntry & {
  readonly style: StyleFn
}

export type BuiltinStyleJson = DescInfo & {
  type: 'builtin'
}

export type DynamicStyleOptionsJson = {
  units?: 'm' | 'dd'
  dotsPerInch?: number
}

export type DynamicStyleFileJson = DescInfo & {
  type: 'dynamic'
  path: string
  options?: DynamicStyleOptionsJson
}

export type StyleJson = BuiltinStyleJson | DynamicStyleFileJson

export class Style {
  static readonly registry = new Registry<NamedStyle>('STYLE')

  static async build(styleEntries: Dict<StyleJson>): Promise<Registry<NamedStyle>> {

    Style.registry.set('default',{ id: 'default',title: 'Default',style: defaultStyleFn })
    const styleValidator = new StyleValidator(dynamicStyleSchema, 'Dynamic Style Schema')

    for (const [name, entry] of Object.entries(styleEntries)) {
        const style = await Style.create(name, entry, styleValidator)
        Style.registry.set(name, style)
    }
    return Style.registry
  }

  static async create(
    id: string,
    entry: StyleJson,
    dynamicStyleValidator: JsonValidator<DynamicStyleJson>
  ): Promise<NamedStyle> {
    switch (entry.type) {
      case 'builtin':
        if (!BUILTIN_STYLES[id]) {
          throw new Error(`Unknown builtin style "${id}"`)
        }

        return {
          id,
          title: entry.title ?? titleFromId(id),
          abstract: entry.abstract,
          style: BUILTIN_STYLES[id]
        }

      case 'dynamic': {
        const stylePath = entry.path

        try {
          const json = dynamicStyleValidator.validate(stylePath)
          Style.validateDynamicStyleImages(id, json)
          const style = await createDynamicStyleFn(id, json, {
            units: entry.options?.units,
            dotsPerInch: entry.options?.dotsPerInch
          })
          return {
            id,
            title: entry.title ?? json.title ?? titleFromId(id),
            abstract: entry.abstract,
            style
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Invalid dynamic style "${id}" at ${stylePath}: ${message}`)
        }
      }
    }
  }

  private static validateDynamicStyleImages(id: string, json: DynamicStyleJson): void {
    for (const source of collectLocalImageSources(json)) {
      const image = new CanvasImage()

      try {
        image.src = source
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`image "${source}" is not loadable in dynamic style "${id}": ${message}`)
      }

      if (image.width <= 0 || image.height <= 0) {
        throw new Error(`image "${source}" is not loadable in dynamic style "${id}": width=${image.width} height=${image.height}`)
      }
    }
  }
}

class StyleValidator extends JsonValidator<DynamicStyleJson> {
  protected transform(document: unknown): unknown {
    return new DefsSolver('dynamic style').solve(document, 'dynamic style')
  }
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || id
}

function collectLocalImageSources(value: unknown, sources = new Set<string>()): string[] {
  if (typeof value === 'string') {
    if (isLocalImageSource(value)) sources.add(value)
    return [...sources]
  }

  if (Array.isArray(value)) {
    for (const item of value) collectLocalImageSources(item, sources)
    return [...sources]
  }

  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectLocalImageSources(item, sources)
  }

  return [...sources]
}

function isLocalImageSource(value: string): boolean {
  const source = value.trim()
  if (source === '' || source.startsWith('=>')) return false
  if (source.startsWith('<svg') || source.startsWith('data:')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return false
  return /\.(svg|png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(source)
}
