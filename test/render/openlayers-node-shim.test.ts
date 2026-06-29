import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from 'canvas'
import { describe, expect, test, vi } from 'vitest'
import '../../src/render/openlayers-node-shim.js'

describe('openlayers node shim', () => {
  test('creates canvas-like DOM globals required by OpenLayers', async () => {
    const document = globalThis.document as any
    const canvas = document.createElement('canvas')
    const namespacedCanvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas')

    expect(canvas.style).toEqual({})
    expect(namespacedCanvas.style).toEqual({})
    expect(globalThis.HTMLCanvasElement).toBeDefined()
    expect(globalThis.HTMLImageElement).toBeDefined()
    expect(globalThis.ImageData).toBeDefined()
    expect(await globalThis.createImageBitmap(canvas)).toBe(canvas)
    expect(() => document.createElement('img')).toThrow('Unsupported element: img')
  })

  test('loads images from data urls, files and buffers with browser-like events', async () => {
    const png = createPngBuffer()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    const tmpFile = path.join(os.tmpdir(), `openlayers-node-shim-${process.pid}.png`)
    await writeFile(tmpFile, png)

    const fromDataUrl = newImage()
    const loadListener = vi.fn()
    fromDataUrl.addEventListener('load', loadListener)
    fromDataUrl.onload = vi.fn()
    fromDataUrl.src = dataUrl
    await waitForImageEvent()

    expect(fromDataUrl.src).toBe(dataUrl)
    expect(fromDataUrl.complete).toBe(true)
    expect(fromDataUrl.naturalWidth).toBe(2)
    expect(fromDataUrl.naturalHeight).toBe(2)
    await expect(fromDataUrl.decode()).resolves.toBeUndefined()
    expect(loadListener).toHaveBeenCalledTimes(1)
    expect(fromDataUrl.onload).toHaveBeenCalled()

    fromDataUrl.removeEventListener('load', loadListener)
    const onloadCount = fromDataUrl.onload.mock.calls.length
    fromDataUrl.dispatchEvent(new Event('load'))
    expect(loadListener).toHaveBeenCalledTimes(1)
    expect(fromDataUrl.onload).toHaveBeenCalledTimes(onloadCount + 1)

    const fromFilePath = newImage()
    fromFilePath.src = tmpFile
    await waitForImageEvent()
    expect(fromFilePath.complete).toBe(true)
    expect(fromFilePath.naturalWidth).toBe(2)

    const fromFileUrl = newImage()
    fromFileUrl.src = pathToFileURL(tmpFile).href
    await waitForImageEvent()
    expect(fromFileUrl.complete).toBe(true)
    expect(fromFileUrl.naturalHeight).toBe(2)

    const fromBuffer = newImage()
    fromBuffer.src = png
    await waitForImageEvent()
    expect(fromBuffer.src).toBe('')
    expect(fromBuffer.complete).toBe(true)
  })

  test('dispatches error events and rejects decode for invalid image sources', async () => {
    const image = newImage()
    const errorListener = vi.fn()
    image.addEventListener('error', errorListener)
    image.onerror = vi.fn()

    image.src = 'data:image/png;base64'
    await waitForImageEvent()

    expect(image.src).toBe('data:image/png;base64')
    expect(image.complete).toBe(false)
    expect(errorListener).toHaveBeenCalledTimes(1)
    expect(image.onerror).toHaveBeenCalled()
    await expect(image.decode()).rejects.toThrow('Image is not loaded')

    const missingPath = path.join(os.tmpdir(), `missing-openlayers-node-shim-${process.pid}.png`)
    image.src = missingPath
    await waitForImageEvent()

    expect(image.src).toBe(missingPath)
    expect(image.complete).toBe(false)
  })
})

function createPngBuffer(): Buffer {
  const canvas = createCanvas(2, 2)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ff0000'
  context.fillRect(0, 0, 2, 2)
  return canvas.toBuffer('image/png')
}

function newImage(): any {
  return new (globalThis as any).Image()
}

function waitForImageEvent(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
