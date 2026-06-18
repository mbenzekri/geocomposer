import type { DescInfo, RegistryEntry } from '../core/feature.js'
import { JsonValidator } from '../core/json-validator.js'
import { Dict, Registry } from '../core/tools.js'
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
