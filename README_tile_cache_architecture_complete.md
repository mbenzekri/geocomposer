
# README – Architecture d'un cache de tuiles à reconstruction paresseuse

## 1. Objectifs

Cette architecture vise à fournir un cache de tuiles présentant les propriétés suivantes :

- cache logique unique ;
- invalidation sélective pilotée par PostGIS ;
- reconstruction paresseuse (lazy) ;
- une seule génération par tuile ;
- montée en charge horizontale ;
- ArcGIS Enterprise reste uniquement responsable du rendu.

---

# 2. Pourquoi pas un cache HTTP générique

Les solutions comme NGINX Open Source ont été écartées car :

- pas de purge sélective native par tuile ;
- cache adressé par clé de hachage et non par (layer,z,x,y) ;
- pas de cache distribué unique ;
- invalidation difficile.

Le cache est donc un **cache de tuiles**, pas un cache HTTP.

---

# 3. Architecture

```
                        Clients
                           |
                     Load Balancer
                           |
                  +-------------------+
                  |    Cache Node     |
                  |-------------------|
                  | Lookup            |
                  | Generator         |
                  +-------------------+
                        ... N nœuds
                           |
                =========================
                  Stockage partagé
                =========================
                    |              |
             Service de       Bus d'événements
             verrouillage
                           |
                    ArcGIS LB
                           |
              ArcGIS1 ... ArcGISM
```

Tous les Cache Nodes sont identiques.

Il n'existe :
- ni orchestrateur ;
- ni générateur séparé.

---

# 4. Composants

## 4.1 Lookup

Responsabilités :

- reçoit toutes les requêtes HTTP ;
- calcule la clé `(layer,z,x,y)` ;
- lit le stockage partagé ;
- renvoie immédiatement la tuile si elle existe ;
- en cas de miss :
  - transmet la demande au Generator local ;
  - suspend la requête ;
  - attend `TileReady` ou `TileFailed` ;
  - relit la tuile ;
  - répond au client.

Le Lookup ne contacte jamais ArcGIS.

---

## 4.2 Generator

Responsabilités :

- acquérir un verrou distribué sur `(layer,z,x,y)` ;
- garantir une seule génération ;
- appeler ArcGIS via le Load Balancer ;
- écrire atomiquement la tuile ;
- publier `TileReady` ou `TileFailed`.

Le Generator ne répond jamais directement au client.

---

# 5. Flux

## Hit

```
Client
   |
Lookup
   |
Stockage
   |
Hit
   |
Client
```

## Miss

```
Client
   |
Lookup
   |
Miss
   |
Generator
   |
Lock(layer,z,x,y)
   |
ArcGIS LB
   |
ArcGIS Server
   |
Stockage partagé
   |
TileReady
   |
Lookup
   |
Lecture
   |
Client
```

---

# 6. Déduplication

Une seule génération est autorisée par clé.

Les autres requêtes :

- ne regénèrent jamais ;
- ne pollent jamais ;
- attendent l'événement `TileReady`.

---

# 7. Invalidation

Source : table de publication PostGIS.

Processus :

1. récupération de l'emprise modifiée ;
2. calcul des tuiles `(z,x,y)` ;
3. suppression des tuiles du stockage ;
4. aucune reconstruction ;
5. reconstruction uniquement à la prochaine requête.

---

# 8. Reconstruction

Toujours paresseuse.

Une tuile supprimée n'est reconstruite que si elle est demandée.

---

# 9. Verrou distribué

Le Generator tente :

```
Acquire(layer,z,x,y)
```

Si succès :

- génération.

Sinon :

- aucune génération ;
- attente de TileReady.

Le verrou possède un TTL afin d'éviter un blocage permanent.

---

# 10. Bus d'événements

Evénements :

```
TileReady(layer,z,x,y,version)

TileFailed(layer,z,x,y,cause)
```

Le Lookup est abonné.

Aucun polling.

---

# 11. Stockage

Le stockage est la source de vérité.

Propriétés :

- cache logique unique ;
- lecture concurrente ;
- écriture atomique (temporaire + rename) ;
- suppression directe des tuiles invalidées.

---

# 12. ArcGIS Enterprise

ArcGIS n'est jamais contacté directement par les clients.

Toutes les générations passent par :

```
Generator
      |
ArcGIS Load Balancer
      |
ArcGIS Server Cluster
```

Le Load Balancer répartit naturellement les appels de génération.

---

# 13. Scalabilité

## Cache Nodes

Scalabilité horizontale.

Chaque nœud est stateless.

## ArcGIS

Scalabilité indépendante.

Le cluster ArcGIS est dimensionné selon le nombre maximum de générations simultanées.

## Stockage

Cache logique unique partagé par tous les Cache Nodes.

---

# 14. Gestion des pannes

## ArcGIS indisponible

Le Generator publie :

```
TileFailed(...)
```

Le Lookup répond par une erreur.

## Cache Node perdu

Aucun impact sur les autres nœuds.

## Generator perdu

Expiration du TTL du verrou.

Une nouvelle génération pourra être lancée.

---

# 15. Choix retenus

✔ Cache spécifique

✔ Lookup + Generator

✔ Stockage partagé

✔ Verrou distribué

✔ Bus d'événements

✔ Reconstruction lazy

✔ Invalidation pilotée par PostGIS

✔ ArcGIS uniquement pour le rendu

---

# 16. Alternatives écartées

## NGINX Open Source

Rejeté :

- pas de purge native ;
- pas de cache distribué ;
- clés de cache opaques.

## CDN

Rejeté :

- invalidation insuffisamment maîtrisée pour une reconstruction pilotée par les données.

## Génération proactive

Rejetée.

La reconstruction doit rester entièrement paresseuse.

---

# 17. Points ouverts

- choix du stockage partagé (MinIO, FS distribué...) ;
- choix du service de verrouillage ;
- choix du bus d'événements ;
- contrat HTTP exact entre Lookup et Generator ;
- stratégie de timeout des requêtes en attente.
