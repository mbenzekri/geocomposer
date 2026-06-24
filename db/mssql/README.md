# SQL Server local pour le développement

Ce répertoire contient la configuration d'une base SQL Server locale utilisée pour le développement et les tests sur poste Unix.

Toutes les commandes ci-dessous sont à exécuter depuis le répertoire `db/mssql`.

## Prérequis

* Docker
* Docker Compose (`docker compose`)
* Node.js
* npm
* Un client SQL Server optionnel : Azure Data Studio, DBeaver, DataGrip, QGIS avec pilote SQL Server, ou `sqlcmd`

## Structure

```txt
db/
└── mssql/
    ├── package.json
    ├── docker-compose.yml
    ├── init/
    │   └── 01-create-geocdb.sql
    ├── dumps/
    │   └── seed.bak
    └── scripts/
        ├── dump.sh
        ├── init.sh
        ├── reset.sh
        ├── restore.sh
        ├── shell.sh
        ├── sqlcmd.sh
        └── wait.sh
```

Les données SQL Server sont conservées dans le volume Docker nommé `mssql_mssql-data`.

## Configuration par défaut

| Élément | Valeur |
| --- | --- |
| Conteneur | `myproject-mssql` |
| Port | `1433` |
| Login administrateur | `sa` |
| Mot de passe `sa` | `Mssqlserver0!` |
| Base applicative | `geocdb` |
| Login applicatif | `geocuser` |
| Mot de passe applicatif | `Geocomposer0!` |
| Schéma applicatif | `geoc` |

Le mot de passe `sa` est défini dans `docker-compose.yml` :

```yaml
MSSQL_SA_PASSWORD: "Mssqlserver0!"
```

Les valeurs applicatives peuvent être changées par variables d'environnement :

```bash
export MSSQL_DB='geocdb'
export MSSQL_APP_USER='geocuser'
export MSSQL_APP_PASSWORD='Geocomposer0!'
export MSSQL_SCHEMA='geoc'
```

## Scripts npm

```bash
npm run
```

Scripts disponibles :

```txt
up
 down
logs
wait
init
shell
dump
restore
reset
```

## Démarrage

```bash
npm run up
npm run init
```

`npm run init` crée ou vérifie :

* la base `geocdb` ;
* le login SQL Server `geocuser` ;
* l'utilisateur `geocuser` dans la base ;
* le schéma `geoc` ;
* le schéma par défaut de `geocuser` ;
* l'appartenance de `geocuser` au rôle `db_owner`.

## Connexion SQL

```bash
npm run shell
```

Vérifier la base courante :

```sql
SELECT DB_NAME();
GO
```

Vérifier le schéma :

```sql
SELECT SCHEMA_NAME();
GO
```

Quitter `sqlcmd` :

```sql
EXIT
```

## Connexion depuis QGIS via ODBC

Exemple de DSN système `/etc/odbc.ini` :

```ini
[QGIS_MSSQL_LOCAL]
Driver=FreeTDS
Server=localhost
Port=1433
Database=geocdb
TDS_Version=7.4
```

Dans QGIS :

| Champ | Valeur |
| --- | --- |
| Provider/DSN | `QGIS_MSSQL_LOCAL` |
| Host | vide |
| Database | `geocdb` |
| Username | `geocuser` |
| Password | `Geocomposer0!` |
| Trusted connection | décoché |

## Données spatiales

SQL Server contient nativement les types spatiaux `geometry` et `geography`. Il n'y a pas d'équivalent à `CREATE EXTENSION postgis`.

Exemple minimal :

```sql
CREATE TABLE geoc.test_geometry (
  id int IDENTITY(1,1) PRIMARY KEY,
  geom geometry NOT NULL
);
GO

INSERT INTO geoc.test_geometry (geom)
VALUES (geometry::STGeomFromText('POINT(2.3522 48.8566)', 4326));
GO

SELECT id, geom.STAsText() AS wkt
FROM geoc.test_geometry;
GO
```

## Créer le backup de référence

Après chargement ou modification des données :

```bash
npm run dump
```

Le backup de référence est généré ici :

```txt
dumps/seed.bak
```

## Restaurer le backup de référence

```bash
npm run restore
```

La base locale est restaurée à partir de :

```txt
dumps/seed.bak
```

## Réinitialisation complète

```bash
npm run reset
```

Cette commande :

1. arrête le conteneur ;
2. supprime le volume Docker SQL Server ;
3. redémarre SQL Server ;
4. initialise `geocdb`, `geocuser` et le schéma `geoc` ;
5. restaure `dumps/seed.bak` si le fichier existe.

Si `dumps/seed.bak` n'existe pas, une base vide initialisée est conservée.

## Arrêt

```bash
npm run down
```

## Fichiers à versionner

À versionner dans Git :

```txt
package.json
docker-compose.yml
init/
scripts/
dumps/seed.bak
```

À ne pas versionner :

```txt
data/
```

Ajouter dans le `.gitignore` du projet :

```gitignore
db/*/data/
```

## Principe

Le fichier `dumps/seed.bak` est la référence officielle du jeu de données de test. C'est ce fichier qui doit être utilisé pour reconstruire la base sur un autre poste ou dans un environnement de test.
