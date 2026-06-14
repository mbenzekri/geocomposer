# Oracle XE local pour le developpement

Ce repertoire contient une base Oracle XE locale pour les tests GeoComposer.
Le jeu de donnees de reference est le script SQL `init/world.sql`.

Toutes les commandes ci-dessous sont a executer depuis le repertoire
`db/oracle`.

## Prerequis

* Docker
* Docker Compose (`docker compose`)
* Node.js
* npm
* DBeaver, QGIS ou un client Oracle

Verification :

```bash
docker --version
docker compose version
node --version
npm --version
```

## Structure

```txt
db/oracle/
├── package.json
├── docker-compose.yml
│
├── init/
│   ├── README.md
│   └── world.sql
│
└── scripts/
    ├── common.sh
    ├── prepare-sql.mjs
    ├── restore.sh
    └── wait.sh
```

La persistance Oracle est portee par le volume Docker nomme
`oracle_oracle-data`.

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
shell
sys-shell
restore
```

## Demarrage d'Oracle XE

```bash
npm run up
npm run wait
```

`up` demarre uniquement la base. Le premier demarrage peut prendre plusieurs
minutes.

## Arret d'Oracle XE

```bash
npm run down
```

`down` arrete le service Docker Compose. Le volume Oracle nomme est conserve.

## Afficher les logs

```bash
npm run logs
```

## Connexion SQL

Connexion au schema applicatif :

```bash
npm run shell
```

Verification rapide :

```sql
SELECT USER FROM dual;
EXIT;
```

Connexion admin au PDB :

```bash
npm run sys-shell
```

## Parametres de connexion

| Parametre    | Valeur      |
| ------------ | ----------- |
| Hote         | localhost   |
| Port         | 1521        |
| Service      | XEPDB1      |
| Schema       | GEOCOMPOSER |
| Utilisateur  | GEOCOMPOSER |
| Mot de passe | geocomposer |
| Admin        | system      |
| Mot de passe admin | oracle |

Exemple JDBC :

```txt
jdbc:oracle:thin:@//localhost:1521/XEPDB1
```

## Utilisation avec GeoComposer

La configuration d'exemple GeoComposer est disponible dans
`config/config_oracle.example.json`.

Elle utilise le driver Node.js `oracledb` en mode thin, sans Oracle Instant
Client. GeoComposer lit la colonne `MDSYS.SDO_GEOMETRY` comme objet Oracle natif
et convertit la geometrie cote serveur, au lieu de demander a Oracle de produire
du GeoJSON.

## Restaurer le jeu de donnees

```bash
npm run restore
```

La restauration :

1. attend que le conteneur Oracle soit pret ;
2. supprime et recree le schema `GEOCOMPOSER` ;
3. prepare une copie SQL compatible avec `sqlplus` ;
4. copie cette version dans le conteneur ;
5. execute ce script comme utilisateur `GEOCOMPOSER`.

Le script `init/world.sql` cree, charge et indexe la table `WORLD`.
Le restore doit afficher `WORLD_COUNT = 176`.

Pendant la restauration, `scripts/prepare-sql.mjs` prepare une copie temporaire
du SQL pour contourner les limites de `sqlplus` et des constructeurs Oracle sur
les longues collections `MDSYS.SDO_*_ARRAY`. Le fichier source `init/world.sql`
n'est pas modifie.

## Fichiers a versionner

A versionner dans Git :

```txt
package.json
package-lock.json
docker-compose.yml
init/
scripts/
README.md
```

A ne pas versionner :

```txt
data/
```

Le repertoire `data/` peut exister sur un poste ayant utilise une ancienne
configuration par bind mount. Il n'est plus utilise par `docker-compose.yml`.
