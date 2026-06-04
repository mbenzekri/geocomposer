## Todo liste du projet

### Fait

- [x] Revoir les tests de style pour utiliser des styles dynamic.

### A decider - bugs probables / incoherences

- [ ] Corriger la prise en compte du port dans `src/geo-composer.ts`: `--port` est parse, `PORT` est lu, mais `server.listen()` utilise encore `config.server.port`; rendre le port effectif et les logs coherents.
- [ ] Corriger les scripts `serve:wms` et `serve:xyz` dans `package.json` ou recreer les fichiers cibles absents (`src/example/run-world-wms-server.ts`, `src/example/run-world-xyz-server.ts`).
- [ ] Corriger la reference README vers `src/example/world-services-openlayers.html`, qui n'existe pas dans le depot actuel; pointer vers le viewer existant ou ajouter le fichier.
- [ ] Corriger `config.schema.json` pour `layers.*.pointProperties`: `x`, `y` et `crs` doivent etre des schemas `{ "type": "string" }`, pas des chaines brutes.
- [ ] Decider de la strategie GeoPackage sous Node: exiger explicitement Node `22.5+` (`engines`, README, scripts demo) ou ajouter un fallback SQLite natif non-GDAL.

### A decider - fiabilite et production

- [ ] Ajouter des timeouts et `AbortSignal` de bout en bout pour WMS/XYZ/WMTS/GetFeatureInfo afin qu'une requete longue ferme bien les streams, les sources et le rendu.
- [ ] Ajouter un service de logs injectable au lieu de `console.log/error` direct dans `GeoComposer`, WMS, XYZ, WMTS et `DynamicStyle`; inclure request id, duree, statut, taille et niveau.
- [ ] Mettre un verrou "in-flight" dans `TileCache` ou dans les services de tuiles pour eviter plusieurs rendus concurrents du meme tile absent.
- [ ] Ajouter une cle de version de cache de tuiles basee sur config/style/source, ou une convention de purge automatique, pour eviter de servir des tuiles obsoletes apres changement de style.
- [ ] Eviter la materialisation complete des lignes GeoPackage dans `GpkgReader.stream()` (`.all()`); preferer une iteration par ligne si l'API SQLite disponible le permet.
- [ ] Mettre en cache les extents utilises par les capabilities WMS/WMTS, surtout quand ils sont calcules en streamant des sources fichier.

### A decider - indexation et acces aleatoire

- [ ] Ajouter des tests de round-trip `sourceRef -> read(sourceRef)` pour GeoJSON, GML, Shapefile/DBF, GeoPackage et MemSource.
- [ ] Verifier par tests que les slices `sourceRef` GeoJSON et GML sont directement parseables, et que le `sourceRef` Shapefile inclut bien les 8 octets d'en-tete SHP plus le record DBF complet.
- [ ] Formaliser un `SourceRefValidator` ou une suite d'assertions partagee pour eviter que les transform streams perdent `sourceRef`, `related` ou `recordIndex`.
- [ ] Preparer l'API d'index spatial/R-tree pour les `FileSource` avec `sourceRef` byte-range, sans melanger avec `DbSource`/GeoPackage.
- [ ] Optimiser `Layer.query()` quand le CRS demande differe du CRS source: transformer la bbox de requete vers le CRS source avant de streamer toute la source, quand c'est possible.

### A decider - styles Dynamic

- [ ] Ajouter un schema dedie aux fichiers DynStyle (`config/styles/*.json`) et valider les styles au chargement, pas seulement a l'execution.
- [ ] Encadrer l'usage de `new Function` dans `DynamicStyle`: mode "trusted config" explicite, documentation du risque, ou mini-langage/compilation plus limitee si les configs peuvent etre non fiables.
- [ ] Rendre les erreurs de pointeur dynamique plus strictes: signaler les `dynamic.pointer` qui ne ciblent aucun style/objet au lieu de les ignorer silencieusement.
- [ ] Ajouter une limite ou strategie de purge au cache de styles dynamiques si `cacheKey` depend de valeurs a forte cardinalite.
- [ ] Ajouter des tests pour `cacheKey`, `when`, `definitions`, `dynamic`, gradients/patterns/icones, declutter texte et styles multi-geometries.

### A decider - tests et validation

- [ ] Ajouter un vrai runner de tests (`node:test`, Vitest ou equivalent) au lieu de demos seulement; garder les demos comme smoke visuel.
- [ ] Ajouter des tests unitaires pour GeoJSON/GML/Shapefile/GeoPackage parsers, WKB, DBF, axes GML, bbox/hit-test et reprojection.
- [ ] Ajouter des tests de contrats OGC: WMS `GetCapabilities`, `GetMap`, `GetFeatureInfo`, ordre d'axes EPSG:4326 en WMS 1.3.0, erreurs XML, HEAD/OPTIONS.
- [ ] Ajouter des tests XYZ/WMTS: limites z/x/y, `@2x`, cache, `GetCapabilities`, `GetTile`, styles de tilesets multi-couches.
- [ ] Transformer les smoke images en verifications automatisees minimales: dimensions, PNG non vide, pixels attendus, et eventuellement baseline image.
- [ ] Ajouter un test de chargement de `config.json`, `config_red.json` et du schema pour garantir que les exemples restent synchronises.

### A decider - architecture / maintenabilite

- [ ] Decouper les gros fichiers en classes/services plus petites: `dynamic-style.ts`, `gml-source.ts`, `gpkg-source.ts`, `config.ts`, `wms.ts`.
- [ ] Extraire des parseurs objets explicites (`GeoJsonFeatureParser`, `GmlFeatureParser`, `ShpRecordReader`, `DbfReader`, `WkbReader`) avec tests unitaires dedies.
- [ ] Remplacer les helpers statiques trop larges (`Gt`) par services/domain objects plus explicites pour respecter l'orientation objet du projet.
- [ ] Centraliser la validation runtime de config au lieu de laisser `config.schema.json` et les types TypeScript diverger.
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
