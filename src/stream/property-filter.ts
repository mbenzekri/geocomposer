import type { Feature } from '../core/feature.js'

export type PropertyFilterOperator = '==' | '<' | '>'

export type PropertyFilterCriteria = {
  property: string
  op: PropertyFilterOperator
  value: unknown
}

export type ComparablePropertyValue = string | number | boolean

export class PropertyFilter extends TransformStream<Feature, Feature> {
  constructor(private readonly criteria: PropertyFilterCriteria) {
    super({
      transform: (feature, controller) => {
        if (matchesPropertyFilter(feature, this.criteria)) controller.enqueue(feature)
      }
    })
  }
}

export function matchesPropertyFilter(feature: Feature, criteria: PropertyFilterCriteria): boolean {
  const left = toComparablePropertyValue(feature.properties?.[criteria.property])
  const right = toComparablePropertyValue(criteria.value)
  if (left === null || right === null) return false

  const comparison = comparePropertyValues(left, right)
  if (comparison === null) return false

  if (criteria.op === '==') return comparison === 0
  if (criteria.op === '<') return comparison < 0
  return comparison > 0
}

export function comparePropertyValues(
  left: ComparablePropertyValue,
  right: ComparablePropertyValue
): number | null {
  if (typeof left !== typeof right) return null
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function toComparablePropertyValue(value: unknown): ComparablePropertyValue | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'number' && Number.isNaN(value) ? null : value
  }

  return null
}
