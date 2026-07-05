import { createWriteStream } from 'node:fs'
import { mkdir, stat, rename, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { openPossiblyGzippedReadStream, openPossiblyGzippedWriteStream } from '../src/core/gzip-tools.js'
import { GeoJsonParser, GeoJsonWriter } from '../src/source/geojson-stream.js'

type Config = {
  downloadDir: string
  output: string
  outputFormat: OutputFormat
  urls: string[]
  concurrency?: number
  highWaterMark?: number
  flushBytes?: number
  gzipLevel?: number
  gzipTool?: GzipTool
  gzipThreads?: number
  zlibChunkSize?: number
  progressIntervalMs?: number
}

type OutputFormat = 'gzip' | 'geojson'
type GzipTool = 'node' | 'pigz'

type DownloadedFile = {
  url: string
  path: string
  bytes: number
}

type SkippedDownload = {
  url: string
  reason: string
}

type MergeStats = {
  files: number
  features: number
}

const configPath = process.argv[2]
if (!configPath) {
  console.error('Usage: npx tsx scripts/build-big-geojson.ts <config.json>')
  process.exit(1)
}

async function readConfig(path: string): Promise<Config> {
  const config = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>

  if (!config.downloadDir || typeof config.downloadDir !== 'string') {
    throw new Error('Config must define downloadDir')
  }

  if (!config.output || typeof config.output !== 'string') {
    throw new Error('Config must define output')
  }

  if (!Array.isArray(config.urls) || config.urls.some((url) => typeof url !== 'string')) {
    throw new Error('Config must define urls as a string array')
  }

  return {
    downloadDir: config.downloadDir,
    output: config.output,
    outputFormat: outputFormat(config.outputFormat, config.output),
    urls: config.urls,
    concurrency: positiveInteger(config.concurrency, 3, 'concurrency'),
    highWaterMark: positiveInteger(config.highWaterMark, 1024 * 1024, 'highWaterMark'),
    flushBytes: positiveInteger(config.flushBytes, 32 * 1024 * 1024, 'flushBytes'),
    gzipLevel: integerInRange(config.gzipLevel, 1, 1, 9, 'gzipLevel'),
    gzipTool: gzipTool(config.gzipTool),
    gzipThreads: positiveInteger(config.gzipThreads, 3, 'gzipThreads'),
    zlibChunkSize: positiveInteger(config.zlibChunkSize, 1024 * 1024, 'zlibChunkSize'),
    progressIntervalMs: nonNegativeInteger(config.progressIntervalMs, 5000, 'progressIntervalMs')
  }
}

async function downloadAll(config: Config): Promise<{ files: DownloadedFile[], skipped: SkippedDownload[] }> {
  await mkdir(config.downloadDir, { recursive: true })

  const files: DownloadedFile[] = []
  const skipped: SkippedDownload[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= config.urls.length) return

      const url = config.urls[index]
      const path = join(config.downloadDir, filenameFromUrl(url))
      const result = await download(url, path)
      if (result.skipped) {
        skipped.push({ url, reason: result.reason })
        console.warn(`[skip] ${index + 1}/${config.urls.length} ${url} ${result.reason}`)
      } else {
        files.push(result.file)
        console.log(`[download] ${index + 1}/${config.urls.length} ${path} ${result.file.bytes} bytes`)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(config.concurrency ?? 3, config.urls.length) }, () => worker())
  )

  return {
    files: files.sort((a, b) => config.urls.indexOf(a.url) - config.urls.indexOf(b.url)),
    skipped
  }
}

async function download(url: string, path: string): Promise<
  | { skipped: false, file: DownloadedFile }
  | { skipped: true, reason: string }
> {
  const existingSize = await fileSize(path)
  const headers: Record<string, string> = {}
  if (existingSize > 0) headers.Range = `bytes=${existingSize}-`

  const response = await fetch(url, { headers })

  if (response.status === 416 && existingSize > 0) {
    return { skipped: false, file: { url, path, bytes: existingSize } }
  }

  if (response.status === 404) {
    return { skipped: true, reason: '404 Not Found' }
  }

  if (!response.ok && response.status !== 206) {
    throw new Error(`Download failed ${response.status} ${response.statusText}: ${url}`)
  }

  if (!response.body) {
    throw new Error(`Download response has no body: ${url}`)
  }

  const append = response.status === 206 && existingSize > 0
  const output = createWriteStream(path, {
    flags: append ? 'a' : 'w'
  })

  try {
    for await (const chunk of response.body) {
      await write(output, Buffer.from(chunk))
    }
  } finally {
    output.end()
    await once(output, 'finish')
  }

  return { skipped: false, file: { url, path, bytes: await fileSize(path) } }
}

async function mergeGeoJsonFiles(config: Config, files: DownloadedFile[]): Promise<MergeStats> {
  await mkdir(dirname(config.output), { recursive: true })
  const tempOutput = config.output.endsWith('.gz')
    ? `${config.output}.tmp.gz`
    : `${config.output}.tmp`
  const output = openOutput(tempOutput, config)
  const progress = new Progress(files.length, tempOutput, config.progressIntervalMs ?? 5000)
  const writer = new GeoJsonWriter((chunk) => {
    progress.addBytes(byteLength(chunk))
    return write(output.stream, chunk)
  }, {
    flushBytes: config.flushBytes
  })
  let features = 0
  let mergedFiles = 0
  let nextFile = 0
  let writing = Promise.resolve()

  async function writeFeature(feature: Buffer): Promise<void> {
    const job = writing.then(() => writer.writeFeature(feature))
    writing = job.catch(() => undefined)
    await job
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextFile
      nextFile += 1
      if (index >= files.length) return

      const file = files[index]
      const count = await appendGeoJsonFeatures(file.path, writeFeature, config.highWaterMark ?? 1024 * 1024, progress)
      features += count
      mergedFiles += 1
      progress.addFile()
      console.log(`[merge] ${mergedFiles}/${files.length} ${file.path} ${count} features`)
    }
  }

  try {
    await writer.open()
    await Promise.all(
      Array.from({ length: Math.min(config.concurrency ?? 3, files.length) }, () => worker())
    )
    await writing
    await writer.close()
  } finally {
    progress.stop()
    await output.close()
  }

  await progress.report(true)
  await rename(tempOutput, config.output)
  return { files: mergedFiles, features }
}

type Output = {
  stream: Writable
  close: () => Promise<void>
}

function openOutput(path: string, config: Config): Output {
  if (config.outputFormat === 'gzip' && config.gzipTool === 'pigz') {
    return openPigzOutput(path, config)
  }

  const output = openPossiblyGzippedWriteStream(path, {
    highWaterMark: config.highWaterMark,
    compression: config.outputFormat === 'gzip' ? 'gzip' : 'none',
    gzipLevel: config.gzipLevel,
    zlibChunkSize: config.zlibChunkSize
  })

  return {
    stream: output.stream,
    close: async () => {
      output.stream.end()
      await once(output.stream, 'finish')
    }
  }
}

function openPigzOutput(path: string, config: Config): Output {
  const file = createWriteStream(path, {
    highWaterMark: config.highWaterMark
  })
  const pigz = spawn('pigz', [
    `-${config.gzipLevel ?? 1}`,
    '-p',
    String(config.gzipThreads ?? 3),
    '-c'
  ])
  const stderr: Buffer[] = []
  const fileFinished = once(file, 'finish')
  const pigzExit = once(pigz, 'exit') as Promise<[number | null, NodeJS.Signals | null]>

  pigz.stdout.pipe(file)
  pigz.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))

  return {
    stream: pigz.stdin,
    close: async () => {
      pigz.stdin.end()
      const [code] = await pigzExit
      await fileFinished
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim()
        throw new Error(`pigz failed with exit code ${code}${message ? `: ${message}` : ''}`)
      }
    }
  }
}

async function appendGeoJsonFeatures(
  path: string,
  writeFeature: (feature: Buffer) => Promise<void>,
  highWaterMark: number,
  progress: Progress
): Promise<number> {
  const input = openInput(path, highWaterMark)
  const parser = new GeoJsonParser('utf8')
  let count = 0

  try {
    for await (const chunk of input.stream) {
      parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

      for (;;) {
        const parsed = parser.read()
        if (!parsed) break

        await writeFeature(parsed.raw)
        count += 1
        progress.addFeature()
      }
    }

    parser.finish()
  } finally {
    await input.close()
  }

  return count
}

type Input = {
  stream: AsyncIterable<Buffer | string>
  close: () => Promise<void>
}

function openInput(path: string, highWaterMark: number): Input {
  if (extname(path).toLowerCase() !== '.gz') {
    const input = openPossiblyGzippedReadStream(path, {
      highWaterMark,
      compression: 'none'
    })

    return {
      stream: input.stream,
      close: async () => input.close()
    }
  }

  const pigz = spawn('pigz', ['-d', '-c', path])
  const stderr: Buffer[] = []
  const exited = once(pigz, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  let ended = false

  pigz.stdout.on('end', () => {
    ended = true
  })
  pigz.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))

  return {
    stream: pigz.stdout,
    close: async () => {
      if (!ended) pigz.kill()
      const [code] = await exited
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim()
        throw new Error(`pigz input failed with exit code ${code}${message ? `: ${message}` : ''}`)
      }
    }
  }
}

class Progress {
  private readonly startedAt = performance.now()
  private lastAt = this.startedAt
  private bytes = 0
  private lastBytes = 0
  private features = 0
  private files = 0
  private reporting = false
  private readonly timer?: NodeJS.Timeout

  constructor(
    private readonly totalFiles: number,
    private readonly outputPath: string,
    intervalMs: number
  ) {
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.report(false)
      }, intervalMs)
    }
  }

  addBytes(value: number): void {
    this.bytes += value
  }

  addFeature(): void {
    this.features += 1
  }

  addFile(): void {
    this.files += 1
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async report(final: boolean): Promise<void> {
    if (this.reporting) return
    this.reporting = true

    try {
      const now = performance.now()
      const elapsedSeconds = Math.max((now - this.startedAt) / 1000, 0.001)
      const recentSeconds = Math.max((now - this.lastAt) / 1000, 0.001)
      const recentBytes = this.bytes - this.lastBytes
      const outputBytes = await fileSize(this.outputPath)

      console.log(`[progress${final ? ':final' : ''}] files=${this.files}/${this.totalFiles} features=${this.features} input=${formatBytes(this.bytes)} output=${formatBytes(outputBytes)} avg=${formatRate(this.bytes / elapsedSeconds)} recent=${formatRate(recentBytes / recentSeconds)}`)

      this.lastAt = now
      this.lastBytes = this.bytes
    } finally {
      this.reporting = false
    }
  }
}

async function write(stream: NodeJS.WritableStream, chunk: Buffer | string): Promise<void> {
  if (stream.write(chunk)) return
  await once(stream, 'drain')
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

function filenameFromUrl(value: string): string {
  const url = new URL(value)
  const name = basename(url.pathname)
  if (!name) throw new Error(`URL has no filename: ${value}`)
  return name
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Config ${name} must be a positive integer`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Config ${name} must be a non-negative integer`)
  }
  return Number(value)
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`Config ${name} must be an integer between ${min} and ${max}`)
  }
  return Number(value)
}

function outputFormat(value: unknown, output: string): OutputFormat {
  if (value === undefined) return output.endsWith('.gz') ? 'gzip' : 'geojson'
  if (value === 'gzip' || value === 'geojson') return value
  throw new Error('Config outputFormat must be "gzip" or "geojson"')
}

function gzipTool(value: unknown): GzipTool {
  if (value === undefined) return 'node'
  if (value === 'node' || value === 'pigz') return value
  throw new Error('Config gzipTool must be "node" or "pigz"')
}

function byteLength(chunk: Buffer | string): number {
  return Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes.toFixed(0)} B`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  return `${(bytes / 1024 / 1024 / 1024 / 1024).toFixed(1)} TB`
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

try {
  const config = await readConfig(configPath)
  const downloaded = await downloadAll(config)
  const stats = await mergeGeoJsonFiles(config, downloaded.files)

  console.log(JSON.stringify({
    output: config.output,
    outputFormat: config.outputFormat,
    downloadedFiles: downloaded.files.length,
    downloadedBytes: downloaded.files.reduce((sum, file) => sum + file.bytes, 0),
    skippedFiles: downloaded.skipped.length,
    mergedFiles: stats.files,
    features: stats.features
  }, undefined, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
