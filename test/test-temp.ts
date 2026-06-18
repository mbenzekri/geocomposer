import fs from 'node:fs'
import path from 'node:path'

export const TEST_TEMP_ENV = 'GEOC_TEST_TEMP_DIR'

export function testTempDir(): string {
    const tempDir = process.env[TEST_TEMP_ENV]
    if (!tempDir) {
        throw new Error(`${TEST_TEMP_ENV} is not set. Vitest global setup must create the test temp directory.`)
    }

    const realTempDir = fs.realpathSync(tempDir)
    assertTmpPath(realTempDir)

    const workerTempDir = path.join(realTempDir, workerTempName())
    fs.mkdirSync(workerTempDir, { recursive: true })

    const realWorkerTempDir = fs.realpathSync(workerTempDir)
    assertTmpPath(realWorkerTempDir)
    return realWorkerTempDir
}

export function testTempPath(...parts: string[]): string {
    const tempDir = testTempDir()
    const fullpath = parts.length === 0
        ? tempDir
        : path.resolve(tempDir, ...parts)

    if (fullpath !== tempDir && !fullpath.startsWith(`${tempDir}${path.sep}`)) {
        throw new Error(`Unsafe test path outside temp root: ${fullpath}`)
    }

    return fullpath
}

export function writeTestConfig(filename: string, config: Record<string, unknown>): string {
    const fullpath = testTempPath(filename)
    const prepared = prepareConfig(config)
    fs.mkdirSync(path.dirname(fullpath), { recursive: true })
    fs.writeFileSync(fullpath, JSON.stringify(prepared, undefined, 4))
    return fullpath
}

export function assertTmpPath(value: string): void {
    if (!value.startsWith('/tmp/')) {
        throw new Error(`Unsafe test temp path outside /tmp: ${value}`)
    }
}

function prepareConfig(config: Record<string, unknown>): Record<string, unknown> {
    const prepared = JSON.parse(JSON.stringify(config)) as Record<string, any>

    absolutizePath(prepared, ['$schema'])

    for (const style of Object.values(prepared.styles ?? {})) {
        absolutizePath(style, ['path'])
    }

    for (const source of Object.values(prepared.sources ?? {})) {
        absolutizePath(source, ['path'])
        absolutizePath(source, ['shpPath'])
        absolutizePath(source, ['dbfPath'])
    }

    return prepared
}

function absolutizePath(document: any, props: string[]): void {
    let entry = document
    for (let index = 0; index < props.length - 1; index += 1) {
        entry = entry?.[props[index]]
    }

    if (entry == null) return

    const prop = props[props.length - 1]
    const value = entry[prop]
    if (typeof value !== 'string') return
    if (value.startsWith('$') || path.isAbsolute(value)) return

    entry[prop] = path.resolve(process.cwd(), repoRelativePath(value))
}

function repoRelativePath(value: string): string {
    return value.startsWith('../../')
        ? value.slice('../../'.length)
        : value
}

function workerTempName(): string {
    return `worker-${process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? process.pid}`
}
