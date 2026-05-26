import type { IncomingMessage, ServerResponse } from 'node:http'

export abstract class Service {
  readonly path: string

  protected constructor(
    readonly name: string,
    path: string
  ) {
    this.path = normalizeServicePath(path)
  }

  matches(pathname: string): boolean {
    return pathname === this.path
  }

  abstract open(): Promise<void>
  abstract close(): Promise<void>
  abstract handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export function normalizeServicePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized
}
