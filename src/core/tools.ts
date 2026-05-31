
export function isTruthy(value: unknown): boolean {
    return Boolean(Array.isArray(value) ? value.length : value)
}

export function stringify(value: unknown): string {
    return String(value == null ? '' : value)
}

export function escape(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export function nonNegativeInteger(value: string, name: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} must be a non-negative integer`)
    }

    const number = Number(value)
    if (!Number.isSafeInteger(number)) {
        throw new Error(`${name} is outside the safe integer range`)
    }

    return number
}

export function paramsFromUrl(url: URL): Map<string, string> {
    const params = new Map<string, string>()

    for (const [key, value] of url.searchParams.entries()) {
        params.set(key.toUpperCase(), value)
    }

    return params
}
