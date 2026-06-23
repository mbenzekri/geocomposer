# Todo liste du projet

Aujourd'hui, les architectures les plus appréciées sont proches de :

* Planetiler
* Martin
* Tegola
* pg_featureserv
* titiler
* ArcGIS Feature Service
* Mapbox Tiles API

avec PostgreSQL/PostGIS comme backend principal.

---

## MVP (Minimum Viable Product)

Le minimum pour être crédible aujourd'hui :

### 1. Publication de couches (DONE)

Publier une table PostGIS :

```sql
communes
routes
batiments
```

en exposant :

```http
GET /layers
GET /layers/routes
```

---

### 2. API GeoJSON (DONE)

Lecture des objets :

```http
GET /layers/routes/items
GET /layers/routes/items/123
```

avec pagination.

Exemple :

```json
{
  "type": "FeatureCollection",
  "features": [...]
}
```

---

### 3. Filtrage

Très important.

```http
GET /layers/routes/items?type=autoroute
```

ou

```http
GET /layers/routes/items?filter=vitesse>90
```

---

### 4. Filtre spatial (DONE)

```http
GET /layers/routes/items?bbox=...
```

C'est probablement la fonctionnalité la plus utilisée.

---



### 6. Métadonnées

```http
GET /layers
GET /layers/routes/schema
```

avec :

* géométrie
* SRID
* attributs

---

## Must Have

Ce qui manque souvent dans les projets amateurs.

### 1. Vector Tiles (MVT) (DONE)

Support :

```http
/tiles/{z}/{x}/{y}.mvt
```

Aujourd'hui c'est indispensable.

Sans cela :

* MapLibre
* OpenLayers
* Deck.gl

ne seront pas performants.

---

### 2. Support XYZ (DONE)

```http
/{layer}/{z}/{x}/{y}.mvt
```

Plus important que WMTS.

---

### 3. Requêtes CQL

Equivalent OGC API Features.

Exemple :

```http
?filter=population > 10000
```

ou

```http
?filter=intersects(...)
```

---

### 4. Pagination robuste

```http
?limit=100
&offset=200
```

ou

```http
?cursor=...
```

---

### 5. OpenAPI

Documentation automatique.

```http
/openapi.json
/swagger
```

---

### 6. Authentification

Minimum :

* JWT
* API Key

---

### 7. Permissions

Par couche :

```text
routes : lecture
cadastre : interdit
```

---

### 8. OGC API Features (DONE)

Aujourd'hui c'est plus pertinent que WFS.

Endpoints :

```http
/collections
/collections/{id}
/collections/{id}/items
```

---

## Should Have

Fonctionnalités qui font passer du "projet personnel" à "plateforme".

### 1. Styles

Publication de styles :

```json
Mapbox Style
```

---

### 2. Génération de tuiles à la volée

MVT depuis PostGIS.

---

### 3. Cache intégré

Compatible :

```text
Cloudflare
CDN
Nginx
```

---

### 4. Support PMTiles

Très demandé.

```text
planet.pmtiles
```

sert des milliards d'entités efficacement.

---

### 5. Import automatique

Importer :

```text
Shapefile
GeoPackage
GeoJSON
Parquet
FlatGeobuf
```

---

### 6. Edition des données

```http
POST
PATCH
DELETE
```

---

### 7. Transactions

Edition multi-utilisateurs.

---

### 8. Webhooks

```text
feature created
feature updated
```

---

## May Have

Intéressant mais non indispensable.

### 1. Raster

COG :

```text
Cloud Optimized GeoTIFF
```

---

### 2. WMS

Encore utilisé.

Mais moins stratégique.

---

### 3. WMTS

Utile pour les administrations.

---

### 4. WFS Legacy

Compatibilité.

---

### 5. CSW Catalogue

Très niche.

---

### 6. Temps

Données temporelles :

```http
?datetime=2025-01-01
```

---

### 7. Versioning

Historique des objets.

---

## Shining Features

Ce qui différencierait réellement votre produit.

### 1. JSONSchema natif

Connaissant votre travail sur Formulizer, c'est probablement l'opportunité la plus intéressante.

Chaque couche expose :

```json
{
  "type": "object",
  "properties": ...
}
```

Le client peut générer automatiquement :

* formulaires
* validation
* filtres

---

### 2. API unique Data + Tiles

Même couche :

```http
/items
/tiles
/schema
```

sans configuration supplémentaire.

---

### 3. FlatGeobuf natif

```http
/items.fgb
```

Très performant.

---

### 4. Parquet natif

```http
/items.parquet
```

De plus en plus demandé.

---

### 5. SQL sécurisé

Exposer :

```http
/query
```

avec SQL limité :

```sql
SELECT *
FROM routes
WHERE vitesse > 90
```

Beaucoup d'utilisateurs avancés le réclament.

---

### 6. Streaming

```http
/items/stream
```

SSE ou WebSocket.

---

### 7. Multi-tenant

Une seule instance :

```text
tenant A
tenant B
tenant C
```

---

### 8. Full cloud-native

Stockage :

* PostGIS
* S3
* PMTiles
* Parquet

sans dépendance à un système de fichiers local.

---

## Ce que je construirais aujourd'hui

Ordre de développement :

### Phase 1

* PostGIS
* OGC API Features
* GeoJSON
* bbox
* filtres
* OpenAPI

### Phase 2

* MVT
* XYZ
* cache
* authentification

### Phase 3

* styles
* PMTiles
* FlatGeobuf
* édition

### Phase 4

* raster
* COG
* WMS/WMTS

### Différenciation

* JSONSchema natif
* intégration Formulizer
* génération automatique d'UI
* API Data + Tiles + Schema unifiée

C'est probablement l'angle le plus original aujourd'hui : la plupart des serveurs SIG savent publier des données, très peu savent publier simultanément les **données, le schéma métier et l'interface de saisie**.



## Techniques List
### Fait

- [x] Revoir les tests de style pour utiliser des styles dynamic.
- [x] Corriger la prise en compte du port dans `src/geo-composer.ts`: `--port` est parse, `PORT` est lu, mais `server.listen()` utilise encore `config.server.port`; rendre le port effectif et les logs coherents.
- [x] Corriger les scripts `serve:wms` et `serve:xyz` dans `package.json` ou recreer les fichiers cibles absents (`src/example/run-world-wms-server.ts`, `src/example/run-world-xyz-server.ts`).
- [x] Corriger la reference README vers `src/example/world-services-openlayers.html`, qui n'existe pas dans le depot actuel; pointer vers le viewer existant ou ajouter le fichier.
- [x] Corriger `config/config.schema.json` pour `layers.*.pointProperties`: `x`, `y` et `crs` doivent etre des schemas `{ "type": "string" }`, pas des chaines brutes.
- [x] Decider de la strategie GeoPackage sous Node: utiliser Node `22.5+` fourni par l'environnement courant/nvm pour `node:sqlite`, sans ajouter de specificite `package.json` ni fallback SQLite natif non-GDAL.

### A decider - fiabilite et production

- [ ] Ajouter des timeouts et `AbortSignal` de bout en bout pour WMS/XYZ/WMTS/GetFeatureInfo afin qu'une requete longue ferme bien les streams, les sources et le rendu.
- [ ] Ajouter un service de logs injectable au lieu de `console.log/error` direct dans `GeoComposer`, WMS, XYZ, WMTS et `DynamicStyle`; inclure request id, duree, statut, taille et niveau.
- [ ] Mettre un verrou "in-flight" dans `TileCache` ou dans les services de tuiles pour eviter plusieurs rendus concurrents du meme tile absent.
- [ ] Ajouter une cle de version de cache de tuiles basee sur config/style/source, ou une convention de purge automatique, pour eviter de servir des tuiles obsoletes apres changement de style.
- [ ] Eviter la materialisation complete des lignes GeoPackage dans `GpkgReader.stream()` (`.all()`); preferer une iteration par ligne si l'API SQLite disponible le permet.
- [ ] Mettre en cache les extents utilises par les capabilities WMS/WMTS, surtout quand ils sont calcules en streamant des sources fichier.

### A decider - indexation et acces aleatoire

- [x] Ajouter des tests de round-trip `sourceRef -> read(sourceRef)` pour GeoJSON, GML et Shapefile/DBF. Reste GeoPackage et MemSource.
- [x] Verifier par tests que les slices `sourceRef` GeoJSON et GML sont directement parseables, et que le `sourceRef` Shapefile inclut bien les 8 octets d'en-tete SHP plus le record DBF complet.
- [ ] Formaliser un `SourceRefValidator` ou une suite d'assertions partagee pour eviter que les transform streams perdent `sourceRef`, `related` ou `recordIndex`.
- [ ] Preparer l'API d'index spatial/R-tree pour les `FileSource` avec `sourceRef` byte-range, sans melanger avec `DbSource`/GeoPackage.
- [ ] Optimiser `Layer.query()` quand le CRS demande differe du CRS source: transformer la bbox de requete vers le CRS source avant de streamer toute la source, quand c'est possible.

### A decider - styles Dynamic

- [x] Ajouter un schema dedie aux fichiers DynStyle (`config/styles/*.json`) et valider les styles au chargement, pas seulement a l'execution.
- [ ] Encadrer l'usage de `new Function` dans `DynamicStyle`: mode "trusted config" explicite, documentation du risque, ou mini-langage/compilation plus limitee si les configs peuvent etre non fiables.
- [ ] Rendre les erreurs de pointeur dynamique plus strictes: signaler les `dynamic.pointer` qui ne ciblent aucun style/objet au lieu de les ignorer silencieusement.
- [ ] Ajouter une limite ou strategie de purge au cache de styles dynamiques si `cacheKey` depend de valeurs a forte cardinalite.
- [ ] Ajouter des tests pour `cacheKey`, `when`, `definitions`, `dynamic`, gradients/patterns/icones, declutter texte et styles multi-geometries.

### A decider - tests et validation

- [x] Ajouter un vrai runner de tests (Vitest) au lieu de demos seulement; garder les demos comme smoke visuel.
- [ ] Ajouter des tests unitaires pour GeoJSON/GML/Shapefile/GeoPackage parsers, WKB, DBF, axes GML, bbox/hit-test et reprojection.
- [ ] Ajouter des tests de contrats OGC: WMS `GetCapabilities`, `GetMap`, `GetFeatureInfo`, ordre d'axes EPSG:4326 en WMS 1.3.0, erreurs XML, HEAD/OPTIONS.
- [ ] Ajouter des tests XYZ/WMTS: limites z/x/y, `@2x`, cache, `GetCapabilities`, `GetTile`, styles de tilesets multi-couches.
- [ ] Transformer les smoke images en verifications automatisees minimales: dimensions, PNG non vide, pixels attendus, et eventuellement baseline image.
- [ ] Ajouter un test de chargement de `config/config.json`, `config/config_red.json` et du schema pour garantir que les exemples restent synchronises.

### A decider - architecture / maintenabilite

- [ ] Decouper les gros fichiers en classes/services plus petites: `dynamic-style.ts`, `gml-source.ts`, `gpkg-source.ts`, `config.ts`, `wms.ts`.
- [ ] Extraire des parseurs objets explicites (`GeoJsonFeatureParser`, `GmlFeatureParser`, `ShpRecordReader`, `DbfReader`, `WkbReader`) avec tests unitaires dedies.
- [ ] Remplacer les helpers statiques trop larges (`Gt`) par services/domain objects plus explicites pour respecter l'orientation objet du projet.
- [ ] Centraliser la validation runtime de config au lieu de laisser `config/config.schema.json` et les types TypeScript diverger.
- [ ] Clarifier la frontiere API publique dans `src/index.ts`: exporter seulement les abstractions stables ou documenter que tout est experimental.
- [ ] Ajouter une convention de formatage/lint TypeScript pour corriger les espacements incoherents et proteger les futures contributions.

### A decider - formats et donnees

- [ ] Completer le support Shapefile selon les besoins: valeurs DBF `DateTime`, code pages plus larges, mesures Z/M, MultiPatch si necessaire.
- [ ] Completer le support GML selon les besoins: `MultiGeometry`, courbes non lineaires, CRS par feature, `boundedBy`, namespaces/attributs plus robustes.
- [ ] Completer le support GeoPackage selon les besoins: plusieurs tables exposees, `gpkg_spatial_ref_sys` plus complet, index R-tree GeoPackage, GeometryCollection.
- [ ] Decider si les responses `GetFeatureInfo` doivent exposer `sourceRef` pour permettre un futur lien vers les index/attributs.

### A decider - documentation et exploitation

- [ ] Documenter les versions Node supportees, surtout pour `node:sqlite`, et ajuster `demo:all` pour ne pas echouer silencieusement sur un Node trop ancien.
- [ ] Documenter le modele `FileSource` vs `DbSource`, les garanties `sourceRef`, et les invariants attendus par les futurs index.
- [ ] Documenter les conventions de style dynamique: `cacheKey`, `static` vs `dynamic`, securite des expressions, et erreurs courantes.
- [ ] Ajouter une page "operating notes": cache, purge, ports, CORS, reverse proxy, logs, limites WMS, ressources CPU/memoire.
