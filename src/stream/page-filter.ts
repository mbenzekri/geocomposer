export type PageFilterOptions = {
  offset?: number
  limit?: number
}

const PAGE_LIMIT_REACHED = new Error('Page limit reached')

export class PageFilter<T> implements ReadableWritablePair<T, T> {
  readonly readable: ReadableStream<T>
  readonly writable: WritableStream<T>

  constructor(options: PageFilterOptions) {
    let skipped = 0
    let returned = 0
    const offset = options.offset ?? 0
    const limit = options.limit
    let controller: ReadableStreamDefaultController<T>
    let closed = false

    const close = (): void => {
      if (closed) return
      closed = true
      controller.close()
    }

    const stopUpstream = (): never => {
      close()
      throw PAGE_LIMIT_REACHED
    }

    this.readable = new ReadableStream<T>({
      start(readableController) {
        controller = readableController
        if (limit !== undefined && limit <= 0) close()
      }
    })

    this.writable = new WritableStream<T>({
      write(item) {
        if (limit !== undefined && returned >= limit) {
          stopUpstream()
        }

        if (skipped < offset) {
          skipped += 1
          return
        }

        returned += 1
        controller.enqueue(item)
        if (limit !== undefined && returned >= limit) stopUpstream()
      },
      close() {
        close()
      },
      abort(reason) {
        if (closed) return
        closed = true
        controller.error(reason)
      }
    })
  }
}
