import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const viewerPath = new URL('../../src/example/world-viewer.html', import.meta.url)

describe('world-viewer example', () => {
  it('keeps OpenLayers projection API names intact', async () => {
    const html = await readFile(viewerPath, 'utf8')
    const inlineScript = html.match(/<script>\s*([\s\S]*)\s*<\/script>\s*<\/body>/)?.[1]

    expect(inlineScript).toBeDefined()
    if (!inlineScript) throw new Error('world-viewer inline script not found')

    expect(() => new Function(inlineScript)).not.toThrow()
    expect(html).not.toMatch(/\bgetcrs\b|\bdatacrs\b|\bfeaturecrs\b|\bcurrentcrsCode\b|\bsetcrs\b|\bcrselect\b/)
    expect(html).toContain('getProjection()')
    expect(html).toContain('dataProjection')
    expect(html).toContain('featureProjection')
  })
})
