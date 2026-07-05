# Scripts

## Construire un gros GeoJSON

`build-big-geojson.ts` telecharge une liste de fichiers GeoJSON, eventuellement deja compresses en `.gz`, puis fusionne leurs `features` dans un seul `FeatureCollection` de sortie.

Le traitement est fait en streaming :

- les fichiers telecharges ne sont pas charges entierement en memoire ;
- les `features` sont extraites une par une ;
- la sortie est ecrite directement, au format choisi par `outputFormat`.

### Commande

```bash
npx tsx scripts/build-big-geojson.ts scripts/cadastre-parcelles.config.example.json
```

### Configuration

Exemple :

```json
{
  "downloadDir": "tmp/cadastre-parcelles/downloads",
  "output": "tmp/cadastre-parcelles/parcelles-france.geojson",
  "outputFormat": "geojson",
  "concurrency": 3,
  "highWaterMark": 1048576,
  "flushBytes": 33554432,
  "gzipLevel": 1,
  "gzipTool": "pigz",
  "gzipThreads": 3,
  "zlibChunkSize": 1048576,
  "progressIntervalMs": 5000,
  "urls": [
    "https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/01/cadastre-01-parcelles.json.gz"
  ]
}
```

Champs :

- `downloadDir` : repertoire local des fichiers telecharges.
- `output` : fichier final.
- `outputFormat` : `geojson` pour une sortie non compressee, `gzip` pour une sortie gzip. Si absent, le format est deduit de l'extension `.gz`.
- `concurrency` : nombre de telechargements simultanes, puis nombre de fichiers fusionnes en parallele. Valeur par defaut : `3`.
- `highWaterMark` : taille des buffers de lecture/ecriture. Valeur par defaut : `1048576`.
- `flushBytes` : taille du paquet envoye au flux de sortie pendant le merge. Valeur par defaut : `33554432`.
- `gzipLevel` : niveau gzip de sortie quand `outputFormat` vaut `gzip`. Valeur par defaut : `1`.
- `gzipTool` : `node` pour `node:zlib`, `pigz` pour compresser en parallele via le programme externe `pigz`. Valeur par defaut : `node`.
- `gzipThreads` : nombre de threads `pigz` quand `gzipTool` vaut `pigz`. Valeur par defaut : `3`.
- `zlibChunkSize` : taille des chunks zlib pour gzip/gunzip. Valeur par defaut : `1048576`.
- `progressIntervalMs` : intervalle du log de progression pendant le merge. `0` desactive ce log. Valeur par defaut : `5000`.
- `urls` : liste des fichiers GeoJSON ou GeoJSON gzip a fusionner.

Les entrees `.gz` sont decompressees avec `pigz -d -c` pendant le merge. Les fichiers sont traites en parallele selon `concurrency`; l'ordre des features dans la sortie n'est pas garanti.

### Reprise

Si un fichier partiel existe deja dans `downloadDir`, le script tente une reprise HTTP avec l'en-tete `Range`.

Si le serveur ne renvoie pas `206 Partial Content`, le fichier local est retélécharge depuis le debut.

### Sortie

Le script affiche un rapport JSON :

```json
{
  "output": "tmp/cadastre-parcelles/parcelles-france.geojson",
  "outputFormat": "geojson",
  "downloadedFiles": 2,
  "downloadedBytes": 271,
  "mergedFiles": 2,
  "features": 5
}
```

### Limite importante

Un fichier `.geojson.gz` classique est adapte au stockage compact et a la lecture sequentielle, mais pas a l'acces aleatoire par offsets.

Pour construire des indexes GeoComposer (`.idx`, `.clustered.pbf`) avec `sourceRef.offset` et `sourceRef.byteLength`, il faut utiliser un GeoJSON non compresse, ou bien construire ensuite un format indexable separe.
