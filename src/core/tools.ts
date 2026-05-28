import { BBox } from "./types.js"

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

