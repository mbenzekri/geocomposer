# GeoComposer configuration template

Ce template sert de point de départ pour un repo de configuration GeoComposer.

## Utilisation

1. Copier le contenu du template dans un nouveau repo.
2. Modifier `.env` pour choisir la version GeoComposer et le port.
3. Modifier `config.json`, `styles/`, `site/` et le volume `data/`.
4. Lancer le service.

```bash
docker compose --env-file .env -f compose.yml up --build
```

Les schémas `schemas/config.schema.json` et `schemas/dynstyle.schema.json` sont
inclus dans le template et correspondent à la version GeoComposer qui a produit
ce template.

Le répertoire `data/` est monté en volume dans le conteneur. Il n'est pas copié
dans l'image Docker.

Endpoints de test :

```text
http://localhost:3000/wms?SERVICE=WMS&REQUEST=GetCapabilities
http://localhost:3000/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0
http://localhost:3000/tiles/world/0/0/0.png
```
