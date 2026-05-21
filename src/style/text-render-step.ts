import type Style from 'ol/style/Style.js'
import type Text from 'ol/style/Text.js'

export type TextRenderStep = 'layer' | 'map' | 'overlay'

const textRenderSteps = new WeakMap<Text, TextRenderStep>()

export function setTextRenderStep(text: Text, value: unknown): void {
  textRenderSteps.set(text, normalizeTextRenderStep(value))
}

export function getTextRenderStep(text: Text | null): TextRenderStep {
  if (!text) return 'layer'

  return textRenderSteps.get(text) ?? 'layer'
}

export function getStyleTextRenderStep(style: Style): TextRenderStep {
  return getTextRenderStep(style.getText())
}

function normalizeTextRenderStep(value: unknown): TextRenderStep {
  if (value === undefined || value === null || value === '') return 'layer'

  if (value === 'layer' || value === 'map' || value === 'overlay') {
    return value
  }

  throw new Error(`Invalid text render step: ${String(value)}`)
}
