# PostGIS local pour le développement

Ce répertoire contient la configuration d'une base de données PostGIS locale utilisée pour le développement et les tests.

Toutes les commandes ci-dessous sont à exécuter depuis le répertoire `db`.

## Prérequis

* Docker
* Docker Compose (`docker compose`)
* Node.js
* npm
* QGIS, pour charger ou modifier les données manuellement

Vérification :

```bash
docker --version
docker compose version
node --version
npm --version
```

---

## Structure

```txt
db/
├── package.json
├── docker-compose.yml
│
├── data/
│   └── données PostgreSQL locales
│
├── dumps/
│   └── seed.dump
│
├── init/
│   └── 01-postgis.sql
│
└── scripts/
    ├── dump.sh
    └── restore.sh
```

---

## Vérification des scripts npm

Se placer dans le répertoire `db` :

```bash
cd db
```

Afficher les scripts disponibles :

```bash
npm run
```

Le fichier `package.json` doit exposer les scripts utilisés dans ce README :

```txt
up
down
logs
shell
dump
restore
reset
```


---

## Démarrage de PostGIS

```bash
npm run up
```

Vérifier que le conteneur est démarré :

```bash
docker ps
```

Le conteneur PostGIS doit apparaître dans la liste.

---

## Afficher les logs

```bash
npm run logs
```

---

## Connexion SQL

```bash
npm run shell
```

Vérifier que PostGIS est disponible :

```sql
SELECT PostGIS_Version();
```

Quitter `psql` :

```sql
\q
```

---

## Connexion depuis QGIS

Créer une connexion PostgreSQL avec les paramètres suivants :

| Paramètre    | Valeur    |
| ------------ | --------- |
| Hôte         | localhost |
| Port         | 5432      |
| Base         | postgres  |
| Utilisateur  | postgres  |
| Mot de passe | postgres  |

Tester la connexion avant de charger les données.

---

## Chargement des données depuis QGIS

Importer les couches dans la base PostGIS locale depuis QGIS.

Méthode possible :

1. Clic droit sur une couche
2. Exporter
3. Sauvegarder les entités sous...
4. Format : PostgreSQL
5. Sélectionner la connexion PostGIS locale
6. Définir le nom de la table
7. Valider l'import

Après import, vérifier dans QGIS que les tables sont bien visibles dans la connexion PostgreSQL.

---

## Créer le dump de référence

Après chargement ou modification des données dans QGIS :

```bash
npm run dump
```

Le dump de référence est généré ici :

```txt
dumps/seed.dump
```

Ce fichier est la source de vérité pour reconstruire la base de test.

---

## Restaurer le dump de référence

```bash
npm run restore
```

La base locale est restaurée à partir de :

```txt
dumps/seed.dump
```

---

## Réinitialisation complète

Pour supprimer la base locale et repartir du dump de référence :

```bash
npm run reset
```

Cette commande doit :

1. Arrêter le conteneur
2. Supprimer les données PostgreSQL locales
3. Redémarrer PostGIS
4. Restaurer `dumps/seed.dump`

---

## Arrêt de PostGIS

```bash
npm run down
```

---

## Fichiers à versionner

À versionner dans Git :

```txt
package.json
docker-compose.yml
init/
scripts/
dumps/seed.dump
```

À ne pas versionner :

```txt
data/
```

Ajouter dans `.gitignore` du répertoire `db` :

```gitignore
data/
```

---

## Mise à jour du jeu de données de référence

Après modification volontaire des données avec QGIS :

```bash
npm run dump
```

Puis versionner le nouveau dump :

```bash
git add dumps/seed.dump
git commit -m "Update PostGIS test dataset"
```

---

## Principe

Le répertoire `data/` contient les fichiers internes PostgreSQL générés localement par Docker. Il dépend de la machine locale et ne doit pas être utilisé comme source de vérité.

Le fichier `dumps/seed.dump` est la référence officielle du jeu de données de test. C'est ce fichier qui doit être utilisé pour reconstruire la base sur un autre poste ou dans un environnement de test.
