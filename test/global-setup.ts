import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertTmpPath, TEST_TEMP_ENV } from './test-temp.js'

export default async function setup() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'geocomposer-test-'))
    const realTempRoot = await realpath(tempRoot)
    assertTmpPath(realTempRoot)

    process.env[TEST_TEMP_ENV] = realTempRoot

    return async () => {
        const cleanupPath = await realpath(realTempRoot)
        assertTmpPath(cleanupPath)
        await rm(cleanupPath, { recursive: true, force: true })
    }
}
