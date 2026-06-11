# GeoComposer is a GIS Server 


- utilise node-canvas comme backend Canvas serveur
- les features en interne sont des POJO Geojson
- Utilise OpenLayers + Style Ol + canvas pour le rendu
- Utilise Proj4 pour les transformation de coordonnées
- Orientation Web Streams pour le pipeline de rendu (Source -> filtre -> projection -> Rendu) 

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
npx tsx src/geo-composer.ts
```

Pour choisir un fichier de configuration au lancement :

```bash
npm run serve -- --config config.local.json
```

Pour vider les caches de tuiles configurés dans `services.xyz.cache` et
`services.wmts.cache` avant de démarrer le serveur :

```bash
npm run serve -- --config config.local.json --clear-tile-cache
```

Le viewer OpenLayers de test est `src/example/world-demo.html`.
Si vous l'ouvrez avec VS Code Live Server, le projet ignore `cache/**` pour
eviter qu'une tuile XYZ/WMTS rendue recharge automatiquement la page.

Le WMS est exposé sur le chemin `services.wms.path` de `config.json`, par
défaut `/wms`. Les tuiles XYZ sont exposées sur `services.xyz.path` et suivent
le schéma `/tiles/{tileset}/{z}/{x}/{y}.png`, par exemple
`http://localhost:3000/tiles/world/1/1/1.png`.

Le WMTS est exposé sur `services.wmts.path`, par défaut `/wmts`. Il supporte
`GetCapabilities` et `GetTile` en KVP, par exemple
`/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=world&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX=1&TILEROW=1&TILECOL=1&FORMAT=image/png`.

Les tilesets sont déclarés à la racine dans `tilesets`. Les services `xyz` et
`wmts` ne font que sélectionner ces tilesets par nom. Chaque tileset référence
les layers et styles déjà déclarés dans `config.json` avec une propriété
`layers`, même quand il ne contient qu'une seule couche. Les options `tileSize`,
`minZoom`, `maxZoom` et `cacheControl` appartiennent à chaque tileset.

La configuration est décrite par `config.schema.json`. Les sections
`projections`, `sources`, `styles`, `layers` et `tilesets` sont des objets
nommés : la clé porte l'identifiant, ce qui évite les doublons de nom dans les
objets eux-mêmes.

`config.json` peut référencer des variables d'environnement dans ses chaînes :
`$s{NOM}` pour une chaîne, `$i{NOM}` pour un entier, `$f{NOM}` pour un nombre
réel et `$b{NOM}` pour un booléen `true` ou `false` sans tenir compte de la
casse. Quand la chaîne contient uniquement la référence, la valeur injectée
garde son type cible avant la validation JSON Schema ; dans une chaîne
composée, la valeur est convertie en texte. Une même chaîne peut contenir
plusieurs références.

```json
{
  "server": {
    "port": "$i{GEOCOMPOSER_PORT}"
  },
  "services": {
    "wms": {
      "onlineResource": "https://$s{PUBLIC_HOST}:$i{PUBLIC_PORT}/wms"
    }
  },
  "sources": {
    "world-postgis": {
      "connection": {
        "connectionString": "$s{GEOCOMPOSER_POSTGIS_URL}",
        "ssl": "$b{GEOCOMPOSER_POSTGIS_SSL}"
      }
    }
  }
}
```

Le chargement échoue si une variable référencée est absente ou si sa valeur ne
peut pas être convertie vers le type demandé. Le message d'erreur indique la
variable, la référence et le chemin JSON concerné.
