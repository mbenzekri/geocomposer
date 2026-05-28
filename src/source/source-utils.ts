import type { FileHandle } from 'node:fs/promises'

export class FileByteReader {
  static async readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
    let total = 0

    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total)
      if (bytesRead === 0) break
      total += bytesRead
    }

    return total
  }
}

export class AbortSignalGuard {
  static throwIfAborted(signal: AbortSignal | undefined, fallbackMessage: string): void {
    if (signal?.aborted) throw this.reason(signal, fallbackMessage)
  }

  static reason(signal: AbortSignal, fallbackMessage: string): unknown {
    return signal.reason ?? new Error(fallbackMessage)
  }
}
