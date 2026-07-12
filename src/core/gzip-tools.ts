import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, type PathLike } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { extname } from 'node:path'
import type { Readable } from 'node:stream'
import { createGzip, constants as zlibConstants } from 'node:zlib'
import type { Gzip } from 'node:zlib'

export type ReadCompression = 'gzip' | 'none'

export type CompressedReadable = {
  stream: Readable
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
  const compression = options.compression ?? compressionFromPath(path)
  if (compression !== 'gzip') {
    const file = createReadStream(path, {
      highWaterMark: options.highWaterMark
    })

    return {
      stream: file,
      close: () => file.destroy()
    }
  }

  const pigz = spawn('pigz', ['-d', '-c', '-p', '1', '--', String(path)])
  const stderr: Buffer[] = []
  let ended = false

  pigz.stdout.on('end', () => {
    ended = true
  })
  pigz.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  pigz.once('error', (error) => {
    pigz.stdout.destroy(new Error(`pigz failed to start: ${error.message}`))
  })
  pigz.once('exit', (code, signal) => {
    if (code === 0 || ended) return

    const message = Buffer.concat(stderr).toString('utf8').trim()
    const reason = signal ? `signal ${signal}` : `exit code ${code}`
    pigz.stdout.destroy(new Error(`pigz input failed with ${reason}${message ? `: ${message}` : ''}`))
  })

  return {
    stream: pigz.stdout,
    close: () => {
      if (!ended && !pigz.killed) pigz.kill()
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
