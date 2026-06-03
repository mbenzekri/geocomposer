import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

export type TileCacheKey = {
  tileset: string
  z: number
  x: number
  y: number
  scale?: number
}

export class TileCache {
  constructor(private readonly dir: string) {}

  async clear(): Promise<void> {
    const dir = resolve(this.dir)
    if (dir === parse(dir).root) {
      throw new Error(`Refusing to clear tile cache root directory: ${dir}`)
    }

    await rm(dir, { recursive: true, force: true })
  }

  async read(key: TileCacheKey): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key))
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null
      }

      throw error
    }
  }

  async write(key: TileCacheKey, image: Buffer): Promise<void> {
    const path = this.path(key)
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`

    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmpPath, image)

    try {
      await rename(tmpPath, path)
    } catch (error) {
      await unlink(tmpPath).catch(() => {})
      throw error
    }
  }

  private path(key: TileCacheKey): string {
    const scale = key.scale ?? 1
    const fileName = scale === 1
      ? `${key.y}.png`
      : `${key.y}@${encodeURIComponent(String(scale))}x.png`

    return join(
      this.dir,
      encodeURIComponent(key.tileset),
      String(key.z),
      String(key.x),
      fileName
    )
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
