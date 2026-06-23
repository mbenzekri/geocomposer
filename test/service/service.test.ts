import { Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import { describe, expect, test } from 'vitest'
import { Service } from '../../src/service/service.js'
import { request, response, TestService } from './helpers.js'

describe('Service', () => {
  test('normalizes paths, matches exact paths and handles text/url helpers', async () => {
    const service = new TestService('demo', 'demo/')
    const res = response()
    const req = request('/demo?x=1', {
      host: 'example.test',
      'x-forwarded-proto': ['https', 'http']
    })

    expect(service.path).toBe('/demo')
    expect(service.matches('/demo')).toBe(true)
    expect(service.matches('/demo/child')).toBe(false)
    expect(Service.requestUrl(req)).toBe('https://example.test/demo?x=1')
    expect(Service.serviceUrl(req, '/other')).toBe('https://example.test/other')

    Service.setCorsHeaders(res)
    Service.sendText(res, 201, 'hello', 'text/plain')
    expect(res.statusCode).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('content-length')).toBe(5)
    expect(res.body?.toString()).toBe('hello')

    const alreadySent = response()
    alreadySent.markHeadersSent()
    Service.sendText(alreadySent, 200, 'ignored', 'text/plain')
    expect(alreadySent.body).toBeUndefined()
    await expect(service.clearCache()).resolves.toBeUndefined()
  })

  test('uses socket protocol fallback and keeps HEAD bodies empty', () => {
    const tls = new TLSSocket(new Socket())
    Object.defineProperty(tls, 'encrypted', { value: true })
    const req = request('/secure', { host: 'secure.test' }, tls)
    const res = response()

    Service.sendText(res, 204, 'hidden', 'text/plain', true)

    expect(Service.requestUrl(req)).toBe('https://secure.test/secure')
    expect(res.body).toBeUndefined()
  })
})
