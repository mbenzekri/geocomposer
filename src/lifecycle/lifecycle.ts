export type LifecycleResource = {
  open(): Promise<void>
  close(): Promise<void>
}

export type LifecycleOptions = {
  sources?: Iterable<LifecycleResource>
  layers?: Iterable<LifecycleResource>
  services?: Iterable<LifecycleResource>
}

export class Lifecycle {
  private readonly resources: readonly LifecycleResource[]
  private opened = false

  constructor(options: LifecycleOptions) {
    this.resources = [
      ...unique(options.sources ?? []),
      ...unique(options.layers ?? []),
      ...unique(options.services ?? [])
    ]
  }

  async open(): Promise<void> {
    if (this.opened) return

    const opened: LifecycleResource[] = []

    try {
      for (const resource of this.resources) {
        await resource.open()
        opened.push(resource)
      }

      this.opened = true
    } catch (error) {
      try {
        await closeResources([...opened].reverse())
      } catch {
        // Preserve the startup error; cleanup errors are secondary here.
      }
      throw error
    }
  }

  async close(): Promise<void> {
    if (!this.opened) return

    try {
      await closeResources([...this.resources].reverse())
    } finally {
      this.opened = false
    }
  }
}

function unique<T>(resources: Iterable<T>): T[] {
  return [...new Set(resources)]
}

async function closeResources(resources: Iterable<LifecycleResource>): Promise<void> {
  let firstError: unknown

  for (const resource of resources) {
    try {
      await resource.close()
    } catch (error) {
      firstError ??= error
    }
  }

  if (firstError) throw firstError
}
