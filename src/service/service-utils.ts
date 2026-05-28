import type { IncomingMessage, ServerResponse } from 'node:http'
import { TLSSocket } from 'node:tls'

export class ServiceHttp {
  static setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
  }

  static sendText(res: ServerResponse, statusCode: number, body: string, contentType: string, headOnly = false): void {
    if (res.headersSent) {
      res.end()
      return
    }

    res.statusCode = statusCode
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', Buffer.byteLength(body))
    res.end(headOnly ? undefined : body)
  }

  static requestUrl(req: IncomingMessage): string {
    return new URL(req.url ?? '/', this.requestBaseUrl(req)).toString()
  }

  static serviceUrl(req: IncomingMessage, path: string): string {
    return new URL(path, this.requestBaseUrl(req)).toString()
  }

  private static requestBaseUrl(req: IncomingMessage): string {
    const socketProtocol = req.socket instanceof TLSSocket && req.socket.encrypted
      ? 'https'
      : 'http'
    const forwardedProtocol = req.headers['x-forwarded-proto']
    const protocol = Array.isArray(forwardedProtocol)
      ? forwardedProtocol[0] ?? socketProtocol
      : forwardedProtocol ?? socketProtocol
    const host = req.headers.host ?? 'localhost'

    return `${protocol}://${host}`
  }
}

export class ServiceParams {
  static fromUrl(url: URL): Map<string, string> {
    const params = new Map<string, string>()

    for (const [key, value] of url.searchParams.entries()) {
      params.set(key.toUpperCase(), value)
    }

    return params
  }

  static require(params: Map<string, string>, name: string, missingMessage = `${name} is required`): string {
    const value = params.get(name)
    if (value === undefined || value === '') {
      throw new Error(missingMessage)
    }

    return value
  }
}

export class ServiceNumberParser {
  static nonNegativeInteger(value: string, name: string): number {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${name} must be a non-negative integer`)
    }

    const number = Number(value)
    if (!Number.isSafeInteger(number)) {
      throw new Error(`${name} is outside the safe integer range`)
    }

    return number
  }
}
