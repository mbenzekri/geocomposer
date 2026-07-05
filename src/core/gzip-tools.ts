import { createReadStream, createWriteStream, type PathLike } from 'node:fs'
import type { ReadStream, WriteStream } from 'node:fs'
import { extname } from 'node:path'
import { createGzip, createGunzip, constants as zlibConstants } from 'node:zlib'
import type { Gzip, Gunzip } from 'node:zlib'

export type ReadCompression = 'gzip' | 'none'

export type CompressedReadable = {
  stream: ReadStream | Gunzip
  close: () => void
}

export type CompressedWritable = {
  stream: WriteStream | Gzip
  close: () => void
}

export type CompressedStreamOptions = {
  highWaterMark?: number
  compression?: ReadCompression
  gzipLevel?: number
  zlibChunkSize?: number
}

export function compressionFromPath(path: PathLike): ReadCompression {
  return extname(String(path)).toLowerCase() === '.gz' ? 'gzip' : 'none'
}

export function openPossiblyGzippedReadStream(path: PathLike, options: CompressedStreamOptions = {}): CompressedReadable {
  const file = createReadStream(path, {
    highWaterMark: options.highWaterMark
  })

  const compression = options.compression ?? compressionFromPath(path)
  if (compression !== 'gzip') {
    return {
      stream: file,
      close: () => file.destroy()
    }
  }

  const gunzip = createGunzip({
    chunkSize: options.zlibChunkSize
  })
  file.pipe(gunzip)

  return {
    stream: gunzip,
    close: () => {
      gunzip.destroy()
      file.destroy()
    }
  }
}

export function openPossiblyGzippedWriteStream(path: PathLike, options: CompressedStreamOptions = {}): CompressedWritable {
  const file = createWriteStream(path, {
    highWaterMark: options.highWaterMark
  })

  const compression = options.compression ?? compressionFromPath(path)
  if (compression !== 'gzip') {
    return {
      stream: file,
      close: () => file.destroy()
    }
  }

  const gzip = createGzip({
    chunkSize: options.zlibChunkSize,
    level: options.gzipLevel ?? zlibConstants.Z_BEST_SPEED
  })
  gzip.pipe(file)

  return {
    stream: gzip,
    close: () => {
      gzip.destroy()
      file.destroy()
    }
  }
}
