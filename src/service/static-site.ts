import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { Service } from './service.js'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export class StaticSite {
  readonly mountPath = '/site'
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  matches(pathname: string): boolean {
    return pathname === this.mountPath || pathname.startsWith(`${this.mountPath}/`)
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    Service.setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      Service.sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', req.method === 'HEAD')
      return
    }

    const filePath = await this.filePath(req.url ?? this.mountPath)
    if (!filePath) {
      Service.sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', req.method === 'HEAD')
      return
    }

    const body = await readFile(filePath)
    res.statusCode = 200
    res.setHeader('Content-Type', this.contentType(filePath))
    res.setHeader('Content-Length', body.byteLength)
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  private async filePath(url: string): Promise<string | undefined> {
    const pathname = new URL(url, 'http://localhost').pathname
    if (!this.matches(pathname)) return undefined

    const decodedPath = this.decodePath(pathname)
    if (!decodedPath) return undefined

    const sitePath = decodedPath.slice(this.mountPath.length)
    const requested = sitePath === '' || sitePath.endsWith('/')
      ? `${sitePath}/index.html`
      : sitePath
    const filePath = resolve(this.root, `.${requested}`)
    if (!this.isInsideRoot(filePath)) return undefined

    const stats = await this.stat(filePath)
    if (stats?.isFile()) return filePath
    if (!stats?.isDirectory()) return undefined

    const indexPath = resolve(filePath, 'index.html')
    if (!this.isInsideRoot(indexPath)) return undefined
    return (await this.stat(indexPath))?.isFile() ? indexPath : undefined
  }

  private decodePath(pathname: string): string | undefined {
    try {
      const decodedPath = decodeURIComponent(pathname)
      return decodedPath.includes('\0') ? undefined : decodedPath
    } catch {
      return undefined
    }
  }

  private isInsideRoot(filePath: string): boolean {
    const relation = relative(this.root, filePath)
    return relation === '' || (!relation.startsWith('..') && !relation.startsWith(sep))
  }

  private async stat(filePath: string) {
    try {
      return await stat(filePath)
    } catch {
      return undefined
    }
  }

  private contentType(filePath: string): string {
    return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  }
}
