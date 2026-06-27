# CI/CD GeoComposer

Ce document accompagne un repo de configuration créé depuis le template
GeoComposer.

Le repo contient la configuration et le déploiement d'une instance GeoComposer :

- `config.json`
- `styles/`
- `site/`
- `data/`
- `Dockerfile`
- `compose.yml`
- `.env`
- `schemas/config.schema.json`
- `schemas/dynstyle.schema.json`
- `.github/workflows/`

## Principe

GeoComposer est récupéré depuis une release existante. La version utilisée par
ce repo est fixée dans `.env`.

```dotenv
GEOC_VERSION=v1.0.2
GEOC_RELEASE_BASE_URL=https://github.com/mbenzekri/geocomposer/releases/download
GEOC_PORT=3000
GEOC_LOGLEVEL=LOG
```

Le fichier `.env` est versionné. Chaque branche d'environnement peut donc porter
sa propre version GeoComposer et ses propres paramètres non sensibles.

```text
develop -> dev
recette -> recette
main    -> production
```

Les secrets ne doivent pas être mis dans `.env`. Ils sont injectés par GitHub
Actions, Docker, Kubernetes ou l'orchestrateur cible.

## Schémas

Les schémas JSON sont inclus dans le template :

```text
schemas/config.schema.json
schemas/dynstyle.schema.json
```

Ils correspondent à la version GeoComposer qui a produit ce template. Il n'y a
donc pas de `npm install` nécessaire pour les télécharger.

Les fichiers du template pointent directement vers ces schémas :

```text
config.json                 -> ./schemas/config.schema.json
styles/*.json               -> ../schemas/dynstyle.schema.json
```

## Styles et assets

Les styles sont dans `styles/`.

S'ils utilisent des icônes, images ou pictogrammes pour représenter des points,
ces assets doivent rester dans le repo, par exemple :

```text
styles/
  world.json
  assets/
    poi.png
    marker.svg
```

Les chemins utilisés dans les JSON de style doivent rester valides une fois les
fichiers copiés dans l'image Docker.

## Docker

Le `Dockerfile` télécharge la release GeoComposer indiquée par `.env`, installe
les dépendances de production, puis copie la configuration, les styles et le
site. Les données ne sont pas copiées dans l'image.

Fichiers copiés dans l'image :

```text
config.json -> /app/config.json
styles/     -> /app/styles/
site/       -> /app/site/
```

Les données sont montées en volume :

```text
./data -> /app/data:ro
```

Lancement local :

```bash
docker compose --env-file .env -f compose.yml up --build
```

## Pull request

Sur pull request, la CI doit vérifier au minimum :

- `config.json` est du JSON valide ;
- l'image Docker se construit ;
- le conteneur démarre ;
- un endpoint réel répond, par exemple le WMS `GetCapabilities`.

Le workflow minimal du template est dans :

```text
.github/workflows/validate.yml
```

## Déploiement après merge

Un merge dans une branche d'environnement déclenche le déploiement de cette
branche.

Exemple de cycle :

1. Modifier `config.json`, `styles/` ou `site/` dans une branche `feature/*`.
2. Ouvrir une PR vers `develop`.
3. Laisser la CI construire et vérifier l'image.
4. Merger dans `develop` pour déployer en dev.
5. Merger `develop` vers `recette` pour déployer en recette.
6. Merger `recette` vers `main` pour déployer en production.

La production peut être protégée par une validation manuelle.

## Production

Pour la production :

- protéger la branche `main` ;
- utiliser une image taguée de façon immuable par le workflow ;
- éviter de déployer `latest` ;
- injecter les secrets depuis l'environnement cible ;
- conserver l'image précédente pour rollback.

## Rollback

Un rollback consiste à redéployer l'image précédente.

Il faut garder une trace de :

- la version GeoComposer (`GEOC_VERSION`) ;
- le commit du repo de configuration ;
- le tag ou digest de l'image déployée.

## Checklist

Avant merge :

- `.env` contient la version GeoComposer voulue pour la branche ;
- `config.json` est valide ;
- les styles référencés existent ;
- les assets utilisés par les styles existent ;
- les sources locales référencées existent ;
- l'image Docker se construit ;
- le conteneur démarre.

Avant production :

- la configuration a été testée en recette ;
- les secrets de production sont prêts ;
- le tag d'image est connu ;
- le rollback est possible.
