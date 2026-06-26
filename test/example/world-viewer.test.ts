import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const viewerScriptPath = new URL('../../site/index.js', import.meta.url)

describe('world-viewer example', () => {
  it('keeps OpenLayers projection API names intact', async () => {
    const script = await readFile(viewerScriptPath, 'utf8')

    expect(() => new Function(script)).not.toThrow()
    expect(script).not.toMatch(/\bgetcrs\b|\bdatacrs\b|\bfeaturecrs\b|\bcurrentcrsCode\b|\bsetcrs\b|\bcrselect\b/)
    expect(script).toContain('getProjection()')
    expect(script).toContain('dataProjection')
    expect(script).toContain('featureProjection')
  })
})
