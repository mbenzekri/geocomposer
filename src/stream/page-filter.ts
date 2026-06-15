export type PageFilterOptions = {
  offset?: number
  limit?: number
}

export class PageFilter<T> extends TransformStream<T, T> {
  constructor(options: PageFilterOptions) {
    let skipped = 0
    let returned = 0
    const offset = options.offset ?? 0
    const limit = options.limit

    super({
      transform(item, controller) {
        if (limit !== undefined && returned >= limit) {
          controller.terminate()
          return
        }

        if (skipped < offset) {
          skipped += 1
          return
        }

        returned += 1
        controller.enqueue(item)
        if (limit !== undefined && returned >= limit) controller.terminate()
      }
    })
  }
}
