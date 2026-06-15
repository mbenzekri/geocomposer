import type { Feature } from './feature.js'

export class FeatureIdentity {
  static fromFeature(feature: Feature): string | undefined {
    if (feature.id !== undefined) return String(feature.id)

    const sourceRef = feature.sourceRef
    if (!sourceRef) return undefined

    if (sourceRef.storage === 'database') return String(sourceRef.rowId)
    if (sourceRef.storage === 'mem') return String(sourceRef.featureIndex)
    if (sourceRef.recordIndex !== undefined) return String(sourceRef.recordIndex)

    return undefined
  }
}
