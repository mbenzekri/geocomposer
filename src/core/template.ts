import { isTruthy, stringify, escape } from "./tools.js"
import { Props } from "./tools.js"
export class MarkupTemplate {
  static render(template: string, context: Props): string {
    return this.renderBlock(template, [context])
  }

  private static renderBlock(template: string, stack: unknown[]): string {
    let output = ''
    let index = 0

    while (index < template.length) {
      const start = template.indexOf('{{', index)
      if (start === -1) {
        output += template.slice(index)
        break
      }

      output += template.slice(index, start)

      if (template.startsWith('{{{', start)) {
        const end = template.indexOf('}}}', start + 3)
        if (end === -1) throw new Error('Unclosed template tag')
        output += stringify(this.resolve(template.slice(start + 3, end).trim(), stack))
        index = end + 3
        continue
      }

      const end = template.indexOf('}}', start + 2)
      if (end === -1) throw new Error('Unclosed template tag')

      const tag = template.slice(start + 2, end).trim()
      const marker = tag[0]
      const name = marker === '#' || marker === '^' || marker === '&'
        ? tag.slice(1).trim()
        : tag

      if (marker === '#') {
        const section = this.findSection(template, end + 2, name)
        output += this.renderSection(section.body, this.resolve(name, stack), stack)
        index = section.end
        continue
      }

      if (marker === '^') {
        const section = this.findSection(template, end + 2, name)
        const value = this.resolve(name, stack)
        output += isTruthy(value) ? '' : this.renderBlock(section.body, stack)
        index = section.end
        continue
      }

      if (marker === '/') {
        throw new Error(`Unexpected closing template section: ${name}`)
      }

      if (marker === '!') {
        index = end + 2
        continue
      }

      const value = this.resolve(name, stack)
      output += marker === '&'
        ? stringify(value)
        : escape(stringify(value))
      index = end + 2
    }

    return output
  }

  private static renderSection(body: string, value: unknown, stack: unknown[]): string {
    if (Array.isArray(value)) {
      return value.map((item) => this.renderBlock(body, [item, ...stack])).join('')
    }

    if (!isTruthy(value)) return ''

    if (this.isContext(value)) {
      return this.renderBlock(body, [value, ...stack])
    }

    return this.renderBlock(body, stack)
  }

  private static findSection(template: string, bodyStart: number, name: string): { body: string, end: number } {
    let depth = 1
    let position = bodyStart

    while (position < template.length) {
      const start = template.indexOf('{{', position)
      if (start === -1) break

      const tagStart = template.startsWith('{{{', start) ? start + 3 : start + 2
      const tagEnd = template.startsWith('{{{', start)
        ? template.indexOf('}}}', tagStart)
        : template.indexOf('}}', tagStart)
      if (tagEnd === -1) throw new Error('Unclosed template tag')

      const tag = template.slice(tagStart, tagEnd).trim()
      const marker = tag[0]
      const tagName = marker === '#' || marker === '^' || marker === '/'
        ? tag.slice(1).trim()
        : ''

      if ((marker === '#' || marker === '^') && tagName === name) depth += 1
      if (marker === '/' && tagName === name) {
        depth -= 1
        if (depth === 0) {
          return {
            body: template.slice(bodyStart, start),
            end: tagEnd + (template.startsWith('{{{', start) ? 3 : 2)
          }
        }
      }

      position = tagEnd + (template.startsWith('{{{', start) ? 3 : 2)
    }

    throw new Error(`Unclosed template section: ${name}`)
  }

  private static resolve(path: string, stack: unknown[]): unknown {
    if (path === '.') return stack[0]

    for (const context of stack) {
      const value = this.resolveInContext(path, context)
      if (value !== undefined) return value
    }

    return undefined
  }

  private static resolveInContext(path: string, context: unknown): unknown {
    if (!this.isContext(context)) return undefined

    let value: unknown = context
    for (const segment of path.split('.')) {
      if (!this.isContext(value) || !(segment in value)) return undefined
      value = value[segment]
    }

    return value
  }

  private static isContext(value: unknown): value is Props {
    return typeof value === 'object' && value !== null
  }

}
