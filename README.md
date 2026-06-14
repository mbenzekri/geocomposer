# GeoComposer is a GIS Server 


- utilise node-canvas comme backend Canvas serveur
- les features en interne sont des POJO Geojson
- Utilise OpenLayers + Style Ol + canvas pour le rendu
- Utilise Proj4 pour les transformation de coordonnées
- Orientation Web Streams pour le pipeline de rendu (Source -> filtre -> projection -> Rendu) 

## Installation Ubuntu

Pour travailler avec PostGIS voir ``db/postgis/README.md``
Pour travailler avec Oracle XE voir ``db/oracle/README.md``

```bash
sudo apt update
sudo apt install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
npm install
npm run demo
```

La démo produit `map.png` à la racine du projet.

## Services

Le serveur GeoComposer charge `config/config.json` une seule fois et expose les
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
npm run serve -- --config config/config.local.json
```

Pour vider les caches de tuiles configurés dans `services.xyz.cache` et
`services.wmts.cache` avant de démarrer le serveur :

```bash
npm run serve -- --config config/config.local.json --clear-tile-cache
```

Le viewer OpenLayers de test est `src/example/world-viewer.html`.
Si vous l'ouvrez avec VS Code Live Server, le projet ignore `cache/**` pour
eviter qu'une tuile XYZ/WMTS rendue recharge automatiquement la page.

Le viewer des styles de test est `src/example/styles-preview.html`.
Il affiches les images produites par les demos


Le WMS est exposé sur le chemin `services.wms.path` de `config/config.json`, par
défaut `/wms`. Les tuiles XYZ sont exposées sur `services.xyz.path` et suivent
le schéma `/tiles/{tileset}/{z}/{x}/{y}.png`, par exemple
`http://localhost:3000/tiles/world/1/1/1.png`.

Le WMTS est exposé sur `services.wmts.path`, par défaut `/wmts`. Il supporte
`GetCapabilities` et `GetTile` en KVP, par exemple
`/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=world&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX=1&TILEROW=1&TILECOL=1&FORMAT=image/png`.

Les tilesets sont déclarés à la racine dans `tilesets`. Les services `xyz` et
`wmts` ne font que sélectionner ces tilesets par nom. Chaque tileset référence
les layers et styles déjà déclarés dans `config/config.json` avec une propriété
`layers`, même quand il ne contient qu'une seule couche. Les options `tileSize`,
`minZoom`, `maxZoom` et `cacheControl` appartiennent à chaque tileset.

La configuration est décrite par `config/config.schema.json`. Les sections
`projections`, `sources`, `styles`, `layers` et `tilesets` sont des objets
nommés : la clé porte l'identifiant, ce qui évite les doublons de nom dans les
objets eux-mêmes.

`config/config.json` peut déclarer des valeurs réutilisables dans un objet racine
`$defs`. Une valeur peut ensuite référencer une définition avec un JSON Pointer
local `#/$defs/nom`. La forme chaîne remplace la valeur complète ; la forme
objet avec `"$ref"` fusionne l'objet référencé avec les propriétés locales, et
les propriétés locales prennent priorité.

```json
{
  "$defs": {
    "worldExtent": [-180, -90, 180, 90],
    "defaultTileset": {
      "tileMatrixSet": "WebMercatorQuad",
      "formats": ["image/png", "application/geo+json"],
      "tileSize": 256,
      "minZoom": 0,
      "maxZoom": 8
    }
  },
  "tilesets": {
    "world": {
      "$ref": "#/$defs/defaultTileset",
      "title": "World",
      "layers": [{ "layer": "world", "style": "world" }]
    }
  },
  "layers": {
    "world": {
      "source": "world",
      "extent": "#/$defs/worldExtent"
    }
  }
}
```

Seule la forme `$defs` avec des références `#/$defs/...` est acceptée pour les
définitions de configuration.

Les fichiers de style dynamique référencés par `styles.*.path` acceptent aussi
une section racine `$defs`, avec la même logique de référence et de fusion.
Cette section sert uniquement à factoriser le JSON avant validation. Elle est
distincte de `definitions`, qui reste le dictionnaire accessible pendant le
rendu via `D` dans les expressions dynamiques.

```json
{
  "$defs": {
    "halo": { "color": "rgba(255, 255, 255, 0.9)", "width": 3 }
  },
  "static": {
    "label": {
      "text": {
        "text": "",
        "stroke": { "$ref": "#/$defs/halo" }
      }
    }
  }
}
```

`config/config.json` peut référencer des variables d'environnement dans ses chaînes :
`$s{NOM}` pour une chaîne, `$i{NOM}` pour un entier, `$f{NOM}` pour un nombre
réel et `$b{NOM}` pour un booléen `true` ou `false` sans tenir compte de la
casse. Quand la chaîne contient uniquement la référence, la valeur injectée
garde son type cible avant la validation JSON Schema ; dans une chaîne
composée, la valeur est convertie en texte. Une même chaîne peut contenir
plusieurs références. Une valeur par défaut peut être ajoutée avec
`$i{NOM|3000}` ; elle est utilisée seulement si la variable d'environnement est
absente et elle est convertie avec le même type que la référence.

```json
{
  "server": {
    "port": "$i{GEOCOMPOSER_PORT|3000}"
  },
  "services": {
    "wms": {
      "onlineResource": "https://$s{PUBLIC_HOST|localhost}:$i{PUBLIC_PORT|3000}/wms"
    }
  },
  "sources": {
    "world-postgis": {
      "connection": {
        "connectionString": "$s{GEOCOMPOSER_POSTGIS_URL}",
        "ssl": "$b{GEOCOMPOSER_POSTGIS_SSL|false}"
      }
    }
  }
}
```

Le chargement échoue si une variable référencée sans défaut est absente ou si
la valeur effective ne peut pas être convertie vers le type demandé. Le message
d'erreur indique la variable, la référence et le chemin JSON concerné.
