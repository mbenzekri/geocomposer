import { MarkupTemplate } from '../core/template.js'

export class XmlText {
  static escape(value: string): string {
    return MarkupTemplate.escape(value)
  }
}
