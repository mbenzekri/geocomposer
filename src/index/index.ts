import type { Feature } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'

export abstract class Index<C = unknown> {
  protected constructor(
    readonly id: string,
    readonly layer: Layer
  ) {}

  abstract stream(criteria?: C): ReadableStream<Feature>

  async get(criteria?: C): Promise<Feature | null> {
    const reader = this.stream(criteria).getReader()

    try {
      const result = await reader.read()
      return result.done ? null : result.value
    } finally {
      await reader.cancel()
    }
  }
}
