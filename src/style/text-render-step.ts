import type Style from 'ol/style/Style.js'
import type Text from 'ol/style/Text.js'

export type TextRenderStep = 'layer' | 'map' | 'overlay'
export type TextDeclutterMode = 'none' | 'first' | 'rank'

const textRenderSteps = new WeakMap<Text, TextRenderStep>()
const textDeclutterModes = new WeakMap<Text, TextDeclutterMode>()
const textDeclutterRanks = new WeakMap<Text, number>()

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

export function setTextDeclutterMode(text: Text, value: unknown): void {
  textDeclutterModes.set(text, normalizeTextDeclutterMode(value))
}

export function getTextDeclutterMode(text: Text | null): TextDeclutterMode {
  if (!text) return 'none'

  return textDeclutterModes.get(text) ?? 'none'
}

export function getStyleTextDeclutterMode(style: Style): TextDeclutterMode {
  return getTextDeclutterMode(style.getText())
}

export function setTextDeclutterRank(text: Text, value: unknown): void {
  textDeclutterRanks.set(text, normalizeTextDeclutterRank(value))
}

export function getTextDeclutterRank(text: Text | null): number {
  if (!text) return 0

  return textDeclutterRanks.get(text) ?? 0
}

export function getStyleTextDeclutterRank(style: Style): number {
  return getTextDeclutterRank(style.getText())
}

export function copyTextRenderMetadata(source: Text, target: Text): void {
  textRenderSteps.set(target, getTextRenderStep(source))
  textDeclutterModes.set(target, getTextDeclutterMode(source))
  textDeclutterRanks.set(target, getTextDeclutterRank(source))
}

function normalizeTextRenderStep(value: unknown): TextRenderStep {
  if (value === undefined || value === null || value === '') return 'layer'

  if (value === 'layer' || value === 'map' || value === 'overlay') {
    return value
  }

  throw new Error(`Invalid text render step: ${String(value)}`)
}

function normalizeTextDeclutterMode(value: unknown): TextDeclutterMode {
  if (value === undefined || value === null || value === '') return 'none'

  if (value === 'none' || value === 'first' || value === 'rank') {
    return value
  }

  throw new Error(`Invalid text declutter mode: ${String(value)}`)
}

function normalizeTextDeclutterRank(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0

  const rank = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(rank)) return rank

  throw new Error(`Invalid text declutter rank: ${String(value)}`)
}
