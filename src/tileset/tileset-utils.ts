import type { Layer } from '../layer/layer.js'
import type { Tileset } from './tileset.js'

export class TilesetLayers {
  static unique(tilesets: Tileset[]): Layer[] {
    return [...new Set(tilesets.flatMap((tileset) => tileset.layers))]
  }
}
