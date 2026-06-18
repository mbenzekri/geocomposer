import { describe, expect, it } from 'vitest'
import { PageFilter } from '../../src/stream/page-filter.js'

async function applyPageFilter<T>(
    values: T[],
    options: {
        offset?: number
        limit?: number
    }
): Promise<T[]> {
    const input = new ReadableStream<T>({
        start(controller) {
            for (const value of values) {
                controller.enqueue(value)
            }

            controller.close()
        }
    })

    const reader = input
        .pipeThrough(new PageFilter<T>(options))
        .getReader()

    const result: T[] = []

    for (;;) {
        const item = await reader.read()
        if (item.done) return result
        result.push(item.value)
    }
}

describe('PageFilter', () => {
    it('returns all items when no offset or limit is provided', async () => {
        await expect(applyPageFilter([1, 2, 3], {}))
            .resolves
            .toEqual([1, 2, 3])
    })

    it('skips items before the offset', async () => {
        await expect(applyPageFilter([1, 2, 3, 4], {
            offset: 2
        })).resolves.toEqual([3, 4])
    })

    it('returns only items up to the limit', async () => {
        await expect(applyPageFilter([1, 2, 3, 4], {
            limit: 2
        })).resolves.toEqual([1, 2])
    })

    it('applies offset and limit together', async () => {
        await expect(applyPageFilter([1, 2, 3, 4, 5], {
            offset: 1,
            limit: 2
        })).resolves.toEqual([2, 3])
    })

    it('returns an empty stream when limit is zero', async () => {
        await expect(applyPageFilter([1, 2, 3], {
            limit: 0
        })).resolves.toEqual([])
    })

    it('returns an empty stream when offset is greater than item count', async () => {
        await expect(applyPageFilter([1, 2], {
            offset: 10
        })).resolves.toEqual([])
    })

    it('returns an empty stream when input is empty', async () => {
        await expect(applyPageFilter([], {
            offset: 1,
            limit: 2
        })).resolves.toEqual([])
    })
})