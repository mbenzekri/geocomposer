import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathsSolver } from '../../src/config/path-solver.js'
import { testTempPath } from '../test-temp.js'

const tempPath = testTempPath()

describe('PathsSolver', () => {
    it('accepts source path patterns when the parent directory exists', () => {
        const dataDir = path.join(tempPath, 'path-solver-pattern')
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(path.join(dataDir, 'cadastre-01-parcelles.json.gz'), '')

        const document = {
            sources: {
                parcelles: {
                    type: 'geojson',
                    path: 'path-solver-pattern/cadastre-*-parcelles.json.gz'
                }
            }
        }

        const result = new PathsSolver(tempPath).solve(document)

        expect(result.sources.parcelles.path).toBe(
            path.join(dataDir, 'cadastre-*-parcelles.json.gz')
        )
    })

    it('rejects source path patterns that match no file', () => {
        const dataDir = path.join(tempPath, 'path-solver-pattern-empty')
        fs.mkdirSync(dataDir, { recursive: true })

        expect(() => new PathsSolver(tempPath).solve({
            sources: {
                parcelles: {
                    type: 'geojson',
                    path: 'path-solver-pattern-empty/cadastre-*-parcelles.json.gz'
                }
            }
        })).toThrow(`File pattern not found: ${path.join(dataDir, 'cadastre-*-parcelles.json.gz')}`)
    })
})
