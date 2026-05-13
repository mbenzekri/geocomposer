import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  Canvas,
  CanvasGradient,
  CanvasPattern,
  Image as CanvasImage,
  ImageData,
  createCanvas
} from 'canvas'

type ImageEventListener = (event: Event) => void

type CanvasImageWithEvents = CanvasImage & {
  onload?: ((event: Event) => void) | null
  onerror?: ((event: Event) => void) | null
}

const imageListeners = new WeakMap<object, Map<string, Set<ImageEventListener>>>()
const imageSources = new WeakMap<object, string>()
const imageLoaded = new WeakMap<object, boolean>()
const imageSrcDescriptor = Object.getOwnPropertyDescriptor(CanvasImage.prototype, 'src')

Object.assign(CanvasImage.prototype, {
  addEventListener(this: CanvasImageWithEvents, type: string, listener: ImageEventListener): void {
    const listeners = imageListeners.get(this) ?? new Map<string, Set<ImageEventListener>>()
    const eventListeners = listeners.get(type) ?? new Set<ImageEventListener>()

    eventListeners.add(listener)
    listeners.set(type, eventListeners)
    imageListeners.set(this, listeners)
  },

  removeEventListener(this: CanvasImageWithEvents, type: string, listener: ImageEventListener): void {
    imageListeners.get(this)?.get(type)?.delete(listener)
  },

  dispatchEvent(this: CanvasImageWithEvents, event: Event): boolean {
    dispatchImageEvent(this, event)
    return true
  },

  decode(this: CanvasImage): Promise<void> {
    if (this.width > 0 && this.height > 0) {
      return Promise.resolve()
    }

    return Promise.reject(new Error('Image is not loaded'))
  }
})

if (imageSrcDescriptor?.set) {
  Object.defineProperty(CanvasImage.prototype, 'src', {
    get(this: CanvasImage) {
      return imageSources.get(this) ?? imageSrcDescriptor.get?.call(this) ?? ''
    },
    set(this: CanvasImageWithEvents, value: string | Buffer) {
      imageSources.set(this, typeof value === 'string' ? value : '')

      try {
        imageSrcDescriptor.set?.call(this, normalizeImageSource(value))
        const loaded = this.width > 0 && this.height > 0
        imageLoaded.set(this, loaded)
        queueMicrotask(() => dispatchImageEvent(this, new Event(loaded ? 'load' : 'error')))
      } catch {
        imageLoaded.set(this, false)
        queueMicrotask(() => dispatchImageEvent(this, new Event('error')))
      }
    }
  })
}

defineImageGetter('complete', function () {
  return imageLoaded.get(this) ?? false
})

defineImageGetter('naturalWidth', function () {
  return (this as CanvasImage).width
})

defineImageGetter('naturalHeight', function () {
  return (this as CanvasImage).height
})

function normalizeImageSource(source: string | Buffer): string | Buffer {
  if (Buffer.isBuffer(source)) {
    return source
  }

  if (source.startsWith('data:')) {
    return dataUrlToBuffer(source)
  }

  if (source.startsWith('file://')) {
    return readFileSync(fileURLToPath(source))
  }

  if (existsSync(source)) {
    return readFileSync(source)
  }

  return source
}

function dataUrlToBuffer(source: string): Buffer {
  const match = /^data:([^,]*?),(.*)$/s.exec(source)
  if (!match) {
    return Buffer.from(source)
  }

  const metadata = match[1]
  const data = match[2]

  if (metadata.endsWith(';base64')) {
    return Buffer.from(data, 'base64')
  }

  return Buffer.from(decodeURIComponent(data), 'utf8')
}

function dispatchImageEvent(image: CanvasImageWithEvents, event: Event): void {
  for (const listener of imageListeners.get(image)?.get(event.type) ?? []) {
    listener.call(image, event)
  }

  const handler = event.type === 'load' ? image.onload : image.onerror
  if (typeof handler === 'function') {
    handler.call(image, event)
  }
}

function defineImageGetter(name: string, get: (this: CanvasImage) => unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(CanvasImage.prototype, name)

  if (!descriptor || descriptor.configurable) {
    Object.defineProperty(CanvasImage.prototype, name, { get })
  }
}

Object.assign(globalThis, {
  CanvasGradient,
  CanvasPattern,
  HTMLCanvasElement: Canvas,
  HTMLImageElement: CanvasImage,
  Image: CanvasImage,
  ImageData,
  document: {
    createElement(tagName: string) {
      if (tagName !== 'canvas') {
        throw new Error(`Unsupported element: ${tagName}`)
      }

      const canvas = createCanvas(1, 1)
      Object.assign(canvas, { style: {} })
      return canvas
    },
    createElementNS(_namespace: string, tagName: string) {
      return this.createElement(tagName)
    }
  },
  createImageBitmap(image: unknown) {
    return Promise.resolve(image)
  }
})
