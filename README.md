# OGC OpenLayers Renderer POC

Prototype TypeScript pour serveur OGC Node.js utilisant :

- Web Streams standard
- features POJO
- géométries maison
- Proj4 réservé aux CRS
- OpenLayers réservé aux styles et au rendu Canvas
- node-canvas comme backend Canvas serveur

## Installation Ubuntu

```bash
sudo apt update
sudo apt install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
npm install
npm run demo
```

La démo produit `map.png` à la racine du projet.

## Services

Le serveur GeoComposer charge `config.json` une seule fois et expose les
services configurés sur le même port :

```bash
npm run serve
```

Vous pouvez aussi lancer directement le point d'entrée :

```bash
npx tsx geo-composer.ts
```

Le WMS est exposé sur le chemin `server.path` de `config.json`, par défaut
`/wms`. Les tuiles XYZ suivent le schéma `/tiles/{layer}/{z}/{x}/{y}.png`, par exemple
`http://localhost:3000/tiles/world/1/1/1.png`. Les couches XYZ référencent
les layers et styles déjà déclarés dans `config.json`. L'option `xyz.cache`
peut pointer vers un répertoire où conserver les PNG rendus.
