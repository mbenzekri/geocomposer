import { resolve } from 'node:path'
import type { DescInfo } from '../core/feature.js'
import { JsonValidator } from '../core/json-validator.js'
import { Dict, Registry } from '../core/tools.js'
import { DefsSolver } from '../config/defs-solver.js'
import { createDynamicStyleFn, type DynamicStyleJson } from './dynamic-style.js'
import { defaultStyleFn } from './default-style.js'
import type { StyleFn } from './style-fn.js'

const DYNAMIC_STYLE_SCHEMA_FILE = 'dynstyle.schema.json'

const BUILTIN_STYLES: Dict<StyleFn> = {
  default: defaultStyleFn
}

export type NamedStyle = {
  readonly name: string
  readonly title?: string
  readonly abstract?: string
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

  static async build(styleEntries: Dict<StyleJson>, baseDir: string): Promise<Registry<NamedStyle>> {

    Style.registry.set('default',{ name: 'default',title: 'Default',style: defaultStyleFn })
    const fullpath = resolve(baseDir, DYNAMIC_STYLE_SCHEMA_FILE)
    const styleValidator = new StyleValidator(fullpath, 'Dynamic Style Schema')

    for (const [name, entry] of Object.entries(styleEntries)) {
        const style = await Style.create(name, entry, baseDir, styleValidator)
        Style.registry.set(name, style)
    }
    return Style.registry
  }

  static async create(
    name: string,
    entry: StyleJson,
    baseDir: string,
    dynamicStyleValidator: JsonValidator<DynamicStyleJson>
  ): Promise<NamedStyle> {
    switch (entry.type) {
      case 'builtin':
        if (!BUILTIN_STYLES[name]) {
          throw new Error(`Unknown builtin style "${name}"`)
        }

        return {
          name,
          title: entry.title ?? titleFromId(name),
          abstract: entry.abstract,
          style: BUILTIN_STYLES[name]
        }

      case 'dynamic': {
        const stylePath = resolve(baseDir, entry.path)

        try {
          const json = dynamicStyleValidator.validate(stylePath)
          const style = await createDynamicStyleFn(name, json, {
            units: entry.options?.units,
            dotsPerInch: entry.options?.dotsPerInch
          })
          return {
            name,
            title: entry.title ?? json.title ?? titleFromId(name),
            abstract: entry.abstract,
            style
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Invalid dynamic style "${name}" at ${stylePath}: ${message}`)
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
