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
