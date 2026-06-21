import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TileCache, type TileCacheKey } from '../../src/tileset/tile-cache.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tile-cache-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('TileCache', () => {
  it('returns null when a tile is missing', async () => {
    const dir = await makeTempDir()
    const cache = new TileCache(dir)

    await expect(cache.read({ tileset: 'main', z: 1, x: 2, y: 3 })).resolves.toBeNull()
  })

  it('writes and reads a tile using the default png extension and scale 1 path', async () => {
    const dir = await makeTempDir()
    const cache = new TileCache(dir)
    const key: TileCacheKey = { tileset: 'main', z: 1, x: 2, y: 3 }
    const image = Buffer.from('png-image')

    await cache.write(key, image)

    await expect(cache.read(key)).resolves.toEqual(image)
    await expect(readFile(join(dir, 'main', '1', '2', '3.png'))).resolves.toEqual(image)
  })

  it('encodes tileset and scale in the written path', async () => {
    const dir = await makeTempDir()
    const cache = new TileCache(dir)
    const key: TileCacheKey = {
      tileset: 'roads/main layer',
      z: 4,
      x: 5,
      y: 6,
      scale: 1.5,
      extension: 'webp'
    }
    const image = Buffer.from('webp-image')

    await cache.write(key, image)

    await expect(cache.read(key)).resolves.toEqual(image)
    await expect(
      readFile(join(dir, 'roads%2Fmain%20layer', '4', '5', '6@1.5x.webp'))
    ).resolves.toEqual(image)
  })

  it('clears the cache directory', async () => {
    const dir = await makeTempDir()
    const cache = new TileCache(dir)
    const key: TileCacheKey = { tileset: 'main', z: 1, x: 2, y: 3 }

    await cache.write(key, Buffer.from('image'))
    await cache.clear()

    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(cache.read(key)).resolves.toBeNull()
  })

  it('refuses to clear a filesystem root directory', async () => {
    const cache = new TileCache('/')

    await expect(cache.clear()).rejects.toThrow('Refusing to clear tile cache root directory: /')
  })

  it('throws non-ENOENT read errors', async () => {
    const dir = await makeTempDir()
    const cache = new TileCache(dir)

    await mkdir(join(dir, 'main', '1', '2'), { recursive: true })
    await mkdir(join(dir, 'main', '1', '2', '3.png'))

    await expect(cache.read({ tileset: 'main', z: 1, x: 2, y: 3 })).rejects.toThrow()
  })

  it('removes the temporary file when the final rename fails', async () => {
    const dir = await makeTempDir()
    const cache = new TileCache(dir)
    const key: TileCacheKey = { tileset: 'main', z: 1, x: 2, y: 3 }
    const finalPath = join(dir, 'main', '1', '2', '3.png')

    await mkdir(finalPath, { recursive: true })

    await expect(cache.write(key, Buffer.from('image'))).rejects.toThrow()

    const entries = await readdir(join(dir, 'main', '1', '2'))
    expect(entries).toEqual(['3.png'])

    const finalPathStat = await stat(finalPath)
    expect(finalPathStat.isDirectory()).toBe(true)
  })
})
