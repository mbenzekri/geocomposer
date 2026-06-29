import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { StaticSite } from '../../src/service/static-site.js'

let root: string

beforeEach(async () => {
  root = path.join(os.tmpdir(), `static-site-${process.pid}-${Date.now()}`)
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await writeFile(path.join(root, 'index.html'), '<h1>Home</h1>')
  await writeFile(path.join(root, 'assets', 'index.html'), '<h1>Assets</h1>')
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log("ok")')
  await writeFile(path.join(root, 'assets', 'data.bin'), 'binary')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StaticSite', () => {
  test('matches the /site mount path', () => {
    const site = new StaticSite(root)

    expect(site.matches('/site')).toBe(true)
    expect(site.matches('/site/assets/app.js')).toBe(true)
    expect(site.matches('/service')).toBe(false)
  })

  test('serves files, redirects mount root and handles methods', async () => {
    const site = new StaticSite(root)

    const redirect = await handle(site, 'GET', '/site')
    expect(redirect.statusCode).toBe(308)
    expect(redirect.headers.Location).toBe('/site/')

    const get = await handle(site, 'GET', '/site/assets/app.js')
    expect(get.statusCode).toBe(200)
    expect(get.headers['Content-Type']).toBe('text/javascript; charset=utf-8')
    expect(get.body.toString()).toBe('console.log("ok")')

    const directoryIndex = await handle(site, 'GET', '/site/assets/')
    expect(directoryIndex.statusCode).toBe(200)
    expect(directoryIndex.body.toString()).toBe('<h1>Assets</h1>')

    const head = await handle(site, 'HEAD', '/site/assets/app.js')
    expect(head.statusCode).toBe(200)
    expect(head.body.length).toBe(0)

    const options = await handle(site, 'OPTIONS', '/site/assets/app.js')
    expect(options.statusCode).toBe(204)

    const post = await handle(site, 'POST', '/site/assets/app.js')
    expect(post.statusCode).toBe(405)
  })

  test('returns 404 for invalid, outside-root and missing paths', async () => {
    const site = new StaticSite(root)

    await expect(handle(site, 'GET', '/service')).resolves.toMatchObject({ statusCode: 404 })
    await expect(handle(site, 'GET', '/site/%00')).resolves.toMatchObject({ statusCode: 404 })
    await expect(handle(site, 'GET', '/site/%E0%A4%A')).resolves.toMatchObject({ statusCode: 404 })
    await expect(handle(site, 'GET', '/site/../package.json')).resolves.toMatchObject({ statusCode: 404 })
    await expect(handle(site, 'GET', '/site/missing.txt')).resolves.toMatchObject({ statusCode: 404 })

    const unknownType = await handle(site, 'GET', '/site/assets/data.bin')
    expect(unknownType.statusCode).toBe(200)
    expect(unknownType.headers['Content-Type']).toBe('application/octet-stream')
  })
})

async function handle(site: StaticSite, method: string, url: string): Promise<MockResponse> {
  const res = new MockResponse()
  await site.handle({ method, url } as any, res as any)
  return res
}

class MockResponse {
  statusCode = 200
  headers: Record<string, string | number | readonly string[]> = {}
  body: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers[name] = value
  }

  end(chunk?: string | Buffer): void {
    if (Buffer.isBuffer(chunk)) this.body = chunk
    else if (typeof chunk === 'string') this.body = Buffer.from(chunk)
  }
}
