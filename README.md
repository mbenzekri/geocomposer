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

Le WMS de démonstration se lance avec :

```bash
npm run serve:wms
```

Le service XYZ configuré dans `config.json` se lance avec :

```bash
npm run serve:xyz
```

Les tuiles suivent le schéma `/tiles/{layer}/{z}/{x}/{y}.png`, par exemple
`http://localhost:3000/tiles/world/1/1/1.png`. Les couches XYZ référencent
les layers et styles déjà déclarés dans `config.json`. L'option `xyz.cache`
peut pointer vers un répertoire où conserver les PNG rendus.
