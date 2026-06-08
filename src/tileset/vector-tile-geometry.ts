import type { BBox, Geometry, Position } from '../core/geometry.js'

type Rect = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type ProcessedVectorGeometry = {
  tileGeometry: Geometry
  worldGeometry: Geometry
}

export type VectorTileGeometryProcessorOptions = {
  bbox: BBox
  extent: number
  buffer: number
  tolerance: number
  tileSize: number
  precision: number
}

export class VectorTileGeometryProcessor {
  private readonly clipRect: Rect
  private readonly tolerance: number
  private readonly minArea: number

  constructor(private readonly options: VectorTileGeometryProcessorOptions) {
    this.clipRect = {
      minX: -options.buffer,
      minY: -options.buffer,
      maxX: options.extent + options.buffer,
      maxY: options.extent + options.buffer
    }
    this.tolerance = options.tolerance * (options.extent / options.tileSize)
    this.minArea = this.tolerance * this.tolerance
  }

  get queryBbox(): BBox {
    const [minX, minY, maxX, maxY] = this.options.bbox
    const bufferX = ((maxX - minX) * this.options.buffer) / this.options.extent
    const bufferY = ((maxY - minY) * this.options.buffer) / this.options.extent

    return [
      minX - bufferX,
      minY - bufferY,
      maxX + bufferX,
      maxY + bufferY
    ]
  }

  process(geometry: Geometry | null): ProcessedVectorGeometry | null {
    if (!geometry) return null

    const tileGeometry = this.toProcessedTileGeometry(geometry)
    if (!tileGeometry) return null

    return {
      tileGeometry,
      worldGeometry: this.tileToWorldGeometry(tileGeometry)
    }
  }

  private toProcessedTileGeometry(geometry: Geometry): Geometry | null {
    switch (geometry.type) {
      case 'Point':
        return this.processPoint(geometry.coordinates)

      case 'MultiPoint': {
        const coordinates = geometry.coordinates
          .map((position) => this.toTilePosition(position))
          .filter((position) => this.contains(position))

        return coordinates.length > 0 ? { type: 'MultiPoint', coordinates } : null
      }

      case 'LineString':
        return this.processLineString(geometry.coordinates)

      case 'MultiLineString': {
        const lines = geometry.coordinates.flatMap((line) => this.processLine(line))
        if (lines.length === 0) return null
        return lines.length === 1
          ? { type: 'LineString', coordinates: lines[0] }
          : { type: 'MultiLineString', coordinates: lines }
      }

      case 'Polygon': {
        const polygon = this.processPolygon(geometry.coordinates)
        return polygon ? { type: 'Polygon', coordinates: polygon } : null
      }

      case 'MultiPolygon': {
        const polygons = geometry.coordinates
          .map((polygon) => this.processPolygon(polygon))
          .filter((polygon): polygon is Position[][] => polygon !== null)

        if (polygons.length === 0) return null
        return polygons.length === 1
          ? { type: 'Polygon', coordinates: polygons[0] }
          : { type: 'MultiPolygon', coordinates: polygons }
      }
    }
  }

  private processPoint(position: Position): Geometry | null {
    const tilePosition = this.toTilePosition(position)
    return this.contains(tilePosition)
      ? { type: 'Point', coordinates: tilePosition }
      : null
  }

  private processLineString(coordinates: Position[]): Geometry | null {
    const lines = this.processLine(coordinates)
    if (lines.length === 0) return null

    return lines.length === 1
      ? { type: 'LineString', coordinates: lines[0] }
      : { type: 'MultiLineString', coordinates: lines }
  }

  private processLine(coordinates: Position[]): Position[][] {
    const tileLine = coordinates.map((position) => this.toTilePosition(position))
    return this.clipLine(tileLine)
      .map((line) => this.simplifyLine(line))
      .map((line) => removeDuplicatePositions(line))
      .filter((line) => line.length >= 2)
  }

  private processPolygon(polygon: Position[][]): Position[][] | null {
    if (polygon.length === 0) return null

    const shell = this.processRing(polygon[0])
    if (!shell) return null

    const holes = polygon
      .slice(1)
      .map((ring) => this.processRing(ring))
      .filter((ring): ring is Position[] => ring !== null)

    return [shell, ...holes]
  }

  private processRing(ring: Position[]): Position[] | null {
    const tileRing = ring.map((position) => this.toTilePosition(position))
    const clipped = clipRingToRect(tileRing, this.clipRect)
    if (!clipped) return null

    const simplified = this.simplifyRing(clipped)
    if (simplified.length < 4) return null
    if (Math.abs(signedRingArea(simplified)) <= this.minArea) return null

    return simplified
  }

  private simplifyLine(line: Position[]): Position[] {
    if (this.tolerance <= 0 || line.length <= 2) return line
    return douglasPeucker(line, this.tolerance)
  }

  private simplifyRing(ring: Position[]): Position[] {
    const closed = closeRing(removeDuplicatePositions(ring))
    if (this.tolerance <= 0 || closed.length <= 4) return closed

    const simplified = closeRing(douglasPeucker(closed, this.tolerance))
    return simplified.length >= 4 ? simplified : closed
  }

  private contains(position: Position): boolean {
    return position[0] >= this.clipRect.minX
      && position[0] <= this.clipRect.maxX
      && position[1] >= this.clipRect.minY
      && position[1] <= this.clipRect.maxY
  }

  private toTilePosition(position: Position): Position {
    const [minX, minY, maxX, maxY] = this.options.bbox
    const x = ((position[0] - minX) / (maxX - minX)) * this.options.extent
    const y = ((maxY - position[1]) / (maxY - minY)) * this.options.extent
    return [x, y]
  }

  private tileToWorldGeometry(geometry: Geometry): Geometry {
    switch (geometry.type) {
      case 'Point':
        return {
          type: 'Point',
          coordinates: this.toWorldPosition(geometry.coordinates)
        }

      case 'MultiPoint':
        return {
          type: 'MultiPoint',
          coordinates: geometry.coordinates.map((position) => this.toWorldPosition(position))
        }

      case 'LineString':
        return {
          type: 'LineString',
          coordinates: geometry.coordinates.map((position) => this.toWorldPosition(position))
        }

      case 'MultiLineString':
        return {
          type: 'MultiLineString',
          coordinates: geometry.coordinates.map((line) =>
            line.map((position) => this.toWorldPosition(position))
          )
        }

      case 'Polygon':
        return {
          type: 'Polygon',
          coordinates: geometry.coordinates.map((ring) =>
            ring.map((position) => this.toWorldPosition(position))
          )
        }

      case 'MultiPolygon':
        return {
          type: 'MultiPolygon',
          coordinates: geometry.coordinates.map((polygon) =>
            polygon.map((ring) =>
              ring.map((position) => this.toWorldPosition(position))
            )
          )
        }
    }
  }

  private toWorldPosition(position: Position): Position {
    const [minX, minY, maxX, maxY] = this.options.bbox
    const x = minX + (position[0] / this.options.extent) * (maxX - minX)
    const y = maxY - (position[1] / this.options.extent) * (maxY - minY)
    return [
      roundToPrecision(x, this.options.precision),
      roundToPrecision(y, this.options.precision)
    ]
  }

  private clipLine(line: Position[]): Position[][] {
    const clippedLines: Position[][] = []
    let current: Position[] = []

    for (let index = 1; index < line.length; index += 1) {
      const clipped = clipSegmentToRect(line[index - 1], line[index], this.clipRect)

      if (!clipped) {
        if (current.length > 0) {
          clippedLines.push(current)
          current = []
        }
        continue
      }

      const [start, end] = clipped
      if (current.length === 0) {
        current.push(start, end)
        continue
      }

      if (samePosition(current[current.length - 1], start)) {
        current.push(end)
      } else {
        clippedLines.push(current)
        current = [start, end]
      }
    }

    if (current.length > 0) clippedLines.push(current)
    return clippedLines
  }
}

function clipSegmentToRect(start: Position, end: Position, rect: Rect): [Position, Position] | null {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  let t0 = 0
  let t1 = 1

  const checks: Array<[number, number]> = [
    [-dx, start[0] - rect.minX],
    [dx, rect.maxX - start[0]],
    [-dy, start[1] - rect.minY],
    [dy, rect.maxY - start[1]]
  ]

  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }

    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }

  return [
    [start[0] + t0 * dx, start[1] + t0 * dy],
    [start[0] + t1 * dx, start[1] + t1 * dy]
  ]
}

function clipRingToRect(ring: Position[], rect: Rect): Position[] | null {
  let output = removeClosingPosition(ring)

  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    output = clipRingEdge(output, rect, edge)
    if (output.length === 0) return null
  }

  const closed = closeRing(removeDuplicatePositions(output))
  return closed.length >= 4 ? closed : null
}

function clipRingEdge(ring: Position[], rect: Rect, edge: 'left' | 'right' | 'top' | 'bottom'): Position[] {
  const output: Position[] = []
  if (ring.length === 0) return output

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]
    const previous = ring[(index + ring.length - 1) % ring.length]
    const currentInside = insideEdge(current, rect, edge)
    const previousInside = insideEdge(previous, rect, edge)

    if (currentInside) {
      if (!previousInside) output.push(intersectEdge(previous, current, rect, edge))
      output.push(current)
    } else if (previousInside) {
      output.push(intersectEdge(previous, current, rect, edge))
    }
  }

  return removeDuplicatePositions(output)
}

function insideEdge(position: Position, rect: Rect, edge: 'left' | 'right' | 'top' | 'bottom'): boolean {
  switch (edge) {
    case 'left':
      return position[0] >= rect.minX
    case 'right':
      return position[0] <= rect.maxX
    case 'top':
      return position[1] >= rect.minY
    case 'bottom':
      return position[1] <= rect.maxY
  }
}

function intersectEdge(start: Position, end: Position, rect: Rect, edge: 'left' | 'right' | 'top' | 'bottom'): Position {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]

  if (edge === 'left' || edge === 'right') {
    const x = edge === 'left' ? rect.minX : rect.maxX
    const t = dx === 0 ? 0 : (x - start[0]) / dx
    return [x, start[1] + t * dy]
  }

  const y = edge === 'top' ? rect.minY : rect.maxY
  const t = dy === 0 ? 0 : (y - start[1]) / dy
  return [start[0] + t * dx, y]
}

function douglasPeucker(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points

  const toleranceSquared = tolerance * tolerance
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  simplifySection(points, 0, points.length - 1, toleranceSquared, keep)
  return points.filter((_, index) => keep[index])
}

function simplifySection(
  points: Position[],
  first: number,
  last: number,
  toleranceSquared: number,
  keep: boolean[]
): void {
  if (last <= first + 1) return

  let maxDistance = -1
  let selected = -1

  for (let index = first + 1; index < last; index += 1) {
    const distance = squaredDistanceToSegment(points[index], points[first], points[last])
    if (distance > maxDistance) {
      maxDistance = distance
      selected = index
    }
  }

  if (selected >= 0 && maxDistance > toleranceSquared) {
    keep[selected] = true
    simplifySection(points, first, selected, toleranceSquared, keep)
    simplifySection(points, selected, last, toleranceSquared, keep)
  }
}

function squaredDistanceToSegment(point: Position, start: Position, end: Position): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]

  if (dx === 0 && dy === 0) return squaredDistance(point, start)

  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)))
  const x = start[0] + t * dx
  const y = start[1] + t * dy
  return squaredDistance(point, [x, y])
}

function squaredDistance(a: Position, b: Position): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
}

export function signedRingArea(ring: Position[]): number {
  let area = 0

  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]
    const next = ring[index + 1]
    area += current[0] * next[1] - next[0] * current[1]
  }

  return area / 2
}

export function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring
  const closed = removeClosingPosition(ring)
  closed.push([...closed[0]] as Position)
  return closed
}

export function removeClosingPosition(ring: Position[]): Position[] {
  if (ring.length > 1 && samePosition(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1)
  }

  return [...ring]
}

export function removeDuplicatePositions(positions: Position[]): Position[] {
  const result: Position[] = []

  for (const position of positions) {
    if (result.length === 0 || !samePosition(result[result.length - 1], position)) {
      result.push(position)
    }
  }

  return result
}

export function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}
