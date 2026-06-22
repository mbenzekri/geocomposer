# Evolutions GeoComposer vers Cloud Platform & CI/CD 

Faire evoluer la version actuel MVP de GC (GeoComposer) vers une cible intégration cloud entreprise

geocomposer-server
  sert les requêtes WMS/WMTS/MVT/OGC

geocomposer-admin
  configure et publie

geocomposer-worker
  génère les caches, pyramides, imports, index



## Fonctionnalités Cloud retenues

1. GeoComposer-admin est une  Extension VS Code
4. L'utilisateur de geocomposer-admin est un utilisateur git
2. Cloud Storage (Cache/Data)
3. CDN
5. SQL Server Spatial
6. Oracle Spatial
7. Monitoring
8. Audit
9. Multi-instance
10. CI/CD


__Message__:

```text
    Composer votre carte avec un large ensemble de reader/transformer 
    déployez votre infrastructure géospatiale partout (Container Local/Cloud).
    connectez-la aux services cloud d'entreprise.
```
## Fonctionnalités

### Format données en entrée (input)

__Fichier plat__
* Geojson
* Shapefile
* GML3
* CSV (TBD)
* Geopackage
* GeoParquet (TBD)
* FlatGeobuf (TBD)

__BDD__
* PostGIS
* Oracle
* SQLServer (TBD)
* MySql (TBD)


### Format données en sortie (output)
__WMS__
* PNG
* JPEG (TBD)
* GML
* GeoJSON

__Tuiles__
* PNG
* GeoJSON
* MVT

| Fonctionnalité                | Community   | Business |
| ----------------------------- | ----------- | -------- |
| Serveur SIG local             | ✓           | ✓        |
| PostgreSQL/PostGIS            | ✓           | ✓        |
| Oracle/SqlServer              | ✗           | ✓        |
| Fichiers SIG locaux           | ✓           | ✓        |
| Fichiers SIG Cloud Storage    | ✗           | ✓        |
| Docker                        | ✓           | ✓        |
| Cache local                   | ✓           | ✓        |
| Cache cloud storage / Redis   | ✗           | ✓        |
| CDN                           | ✗           | ✓        |
| Déploiement Kubernetes        | ✗           | ✓        |
| Déploiement Cloud container   | ✗           | ✓        |
| Monitoring avancé             | ✗           | ✓        |
| Configuration avancé          | ✗           | ✓        |

### Services

* WMS
* WMTS
* XYZ
* OGC open API
* WFS (TBD)

## GeoComposer project 

GeoComposer Project décrit les éléments de composition des services SIG diffusé par un GeoComposer-Server.
C'est un repo GIT composé :
- d'un fichier de configuration (`project.json`), 
- d'un ensembles de profil utilisateur (`profiles.json`),
- d'un ensembles de styles,
- d'un ensemble d'images (png, svg, ...) 
- d'un ensemble de police de caractères : `fonts` (TBD)

```
  config.schema.json
  style.schema.json
  project.json
  profiles.json
  fonts/
    arial.ttf
  icons/
    restaurant.svg
    parking.svg
    school.svg
  styles/
    cadastre.json
    poi.json
```

GeoComposer-Admin est une extension VS Code permettant l'édition d'un GeoComposer Project

L'idée ici est de s'intégrer dans un processus de CI/CD d'entreprise afin de deployer des instances 
de GC containerisé dans l'infratructure cloud de l'entreprise (Azure/AWS/GCloud)
Le processus est :

### construire et utiliser un projet GeoComposer
---

En utilisant la plateforme DevObs de mon choix (GitHub, GitLab, Azure DevOps, Bitbucket, ...)

__Initialiser un projet__
```
- Créer un dépôt Git à partir du template GeoComposer Project
- Cloner le repo sur mon environnement de dev
```

__Faire des adaptations a une config__
```
- Créer une branche pour faire évoluer la configuration du repo à ma convenance sans toucher `main`
- Adapter la configuration, les styles, ...  soit avec editeur avec validation syntaxique ou avec l'extension GeoComposer-Admin.
- Tester ma config avec Docker en local pour valider le rendu: `docker run -v $(pwd):/config geocomposer`
- Commiter et pusher ma branche pour la mettre à disposition
```

__Produire une version à déployer__
```
- Apres review de la branche à intégrer 
- Merger avec `main` (ou une branche production/recette/...')
- Créer le tag de la nouvelle version (ex: `v12.04`)
```

__Deployer__
```
- Fixer les variables d'environnements des containers à deployer pour indiquer cette nouvelle version(GC_VERSION=v12.04)
- appeler un GET /reload sur toutes les instances à redeployer ou forcer un arret.
- le redemarrage des serveurs GC sont redémarré dans la nouvelle version 
```

### Gestion multi-environnements

L'un des avantages de s'appuyer sur Git comme source de vérité est la possibilité de gérer plusieurs environnements de déploiement à partir d'un même GeoComposer Project.

Un environnement correspond à une instance GeoComposer déployée avec une version spécifique du projet :

```text
Développement
Recette
Préproduction
Production
```

### Principe

Chaque environnement GeoComposer est configuré pour suivre une branche ou un tag Git particulier :

```text
develop     → environnement de développement
release     → environnement de recette
main        → environnement de production
```

ou

```text
v1.0.0      → production
v1.1.0-rc1  → recette
```

Le choix de la stratégie est laissé à l'entreprise.

### Exemple avec des branches

```text
develop
   ↓
GC DEV

release
   ↓
GC RECETTE

main
   ↓
GC PROD
```

Lorsqu'une évolution est développée :

```text
feature/new-poi
    ↓
merge develop
    ↓
tests fonctionnels
    ↓
merge release
    ↓
validation métier
    ↓
merge main
```

Chaque environnement recharge automatiquement la version correspondant à sa branche de référence.

### Exemple avec des tags

Une autre approche consiste à déployer uniquement des versions taguées :

```text
v1.0.0
v1.1.0
v1.2.0
```

Les instances GeoComposer sont alors configurées pour utiliser une version précise :

```text
GC_VERSION=v1.1.0
```

Le déploiement d'une nouvelle version consiste simplement à modifier cette référence :

```text
GC_VERSION=v1.2.0
```

puis à demander le redémarrage des instances concernées.

### Rollback

L'utilisation de Git permet de revenir facilement à une version précédente.

Exemple :

```text
Production
    ↓
v1.2.0
```

En cas de problème :

```text
GC_VERSION=v1.1.0
```

puis :

```http
GET /reload
```

Les instances redémarrent alors avec la version précédente du GeoComposer Project.

Aucune modification manuelle des fichiers de configuration n'est nécessaire.

### Déploiement sélectif

Chaque groupe d'instances peut être associé à une référence Git différente :

```text
GC DEV     → develop
GC RECETTE → release
GC PROD    → v1.2.0
```

Cela permet de tester une évolution dans un environnement avant sa promotion vers l'environnement suivant.

### Bénéfices

Cette approche apporte naturellement :

* gestion des environnements via Git ;
* historique complet des déploiements ;
* comparaison des versions ;
* rollback rapide ;
* intégration native avec GitHub, GitLab, Azure DevOps, Bitbucket, Gitea ou tout autre serveur Git ;
* compatibilité avec les pipelines CI/CD existants.

Le GeoComposer Project devient ainsi un artefact versionné, promu progressivement entre les différents environnements de l'entreprise jusqu'à sa mise en production.


sur ma plateforme cloud je crée 
Le point important est le manifest.yaml :

revision: 42
files:
  - path: geocomposer.yaml
    checksum: ...
  - path: layers/poi.yaml
    checksum: ...
  - path: styles/poi.json
    checksum: ...
  - path: assets/icons/restaurant.svg
    checksum: ...

Ainsi, quand le serveur recharge, il prend tout le bundle de la révision 42. Pas :

style v42 + icône v41 + layer v43

Pour le stockage :

Mode	Stockage naturel
Community	dossier local /config
Business	bundle versionné dans object storage ou archive .tar.gz
Historique/audit	Git possible, mais pas obligatoire

Je privilégierais même une publication sous forme d’archive :

geocomposer-config-42.tar.gz

avec :

manifest.yaml
geocomposer.yaml
layers/
styles/
assets/

C’est simple à copier, versionner, déployer, comparer et rollbacker.

Donc oui : styles, icônes, sprites et polices renforcent l’idée que GC doit gérer des config bundles versionnés, plutôt qu’une simple config plate.






## GeoComposer Profiles

GeoComposer ne gère pas :

* les utilisateurs ;
* les mots de passe ;
* les sessions ;
* les groupes ;
* les organisations ;
* les annuaires LDAP/Active Directory ;
* OIDC, SAML ou OAuth.

Ces responsabilités sont déléguées à l'infrastructure externe :

* Reverse Proxy ;
* API Gateway ;
* SSO ;
* Portail métier ;
* Application métier.

GeoComposer reçoit uniquement des informations de contexte via des en-têtes HTTP.

Exemple :

```http
X-GC-Profile: dessinateur
X-GC-Region: PACA
X-GC-Organization: urbanisme
```

GeoComposer ne cherche pas à interpréter la signification métier des informations de contexte.

### Configuration de profils plutot que gestion utilisateur

DAns GeoComposer on s'attacheras à non pas gerer des utilisateurs mais mais plutot des profils applicatifs.
par exemple "admin" , "editeur" , "consultation" "externe"  Liste à configurer dans projet.json 



__Processus d'application des droit:__

```
Front Authentification (Identity-Aware Proxy (IAP))
        ↓
profil GC dans le header HTTP (`http X-GC-profil:Admin`)
        ↓
GeoComposer service
        ↓
GeoComposer Layer
        ↓
Validation profil accès
        ↓
execution dans context/profil
```

Voici une version nettoyée qui reflète ce que nous avons réellement décidé.


### Gestion des Profiles

Le modèle de sécurité repose sur les concepts suivants :

```text
Profile
  └── Rule[]
         ├── Layers
         └── Actions

Request Context
  └── HTTP Headers
```

Un profil représente un ensemble de droits fonctionnels.

Exemples :

```text
admin
dessinateur
viewer
externe
```

Un profil est constitué d'une ou plusieurs règles.


### Rule

Une règle associe :

* une sélection de layers ;
* une liste d'actions autorisées.

Exemple :

```json
{
  "layers": "poi_*",
  "actions": [
    "read",
    "create",
    "update"
  ]
}
```

---

### Actions

Les actions disponibles sont :

| Action | Description               |
| ------ | ------------------------- |
| read   | Consultation des features |
| create | Création de features      |
| update | Modification de features  |
| delete | Suppression de features   |

L'absence d'autorisation implique un refus d'accès.

---

### Sélection des layers

Le champ `layers` peut être exprimé sous deux formes.

__Liste explicite__

```json
{
  "layers": [
    "poi_restaurant",
    "poi_school",
    "roads_primary"
  ]
}
```
Seuls les layers listés sont concernés.


__Expression de sélection__

```json
{
  "layers": "poi_*"
}
```

Le type chaîne représente un motif de sélection.

__Joker__

Le caractère `*` représente une séquence quelconque de caractères.

Exemples :

```json
{
  "layers": "*"
}
```

Tous les layers.

```json
{
  "layers": "poi_*"
}
```

Tous les layers dont l'identifiant commence par :

```text
poi_
```

__Alternatives__

Le caractère `|` représente un opérateur OU.

Exemple :

```json
{
  "layers": "poi_*|roads_*"
}
```
Sélectionne tous les layers correspondant à l'un des motifs.

__Combinaison__

Exemple :

```json
{
  "layers": "poi_*|roads_*|forest"
}
```

Sélectionne :

```text
poi_restaurant
poi_school
roads_primary
roads_secondary
forest
```

---

### Configuration des profils

Exemple :

```json
{
  "profiles": {
    "viewer": {
      "rules": [
        {
          "layers": "*",
          "actions": [
            "read"
          ]
        }
      ]
    },

    "dessinateur": {
      "rules": [
        {
          "layers": "poi_*",
          "actions": [
            "read",
            "create",
            "update"
          ]
        }
      ]
    },

    "admin": {
      "rules": [
        {
          "layers": "*",
          "actions": [
            "read",
            "create",
            "update",
            "delete"
          ]
        }
      ]
    }
  }
}
```

---

### Évaluation d'une requête

Exemple :

```http
X-GC-Profile: dessinateur
```

GeoComposer :

1. charge le profil `dessinateur` ;
2. récupère les règles associées ;
3. vérifie que le layer demandé correspond à une règle ;
4. vérifie que l'action demandée est autorisée ;
5. exécute ou refuse la requête.

---

### Contexte d'exécution

GeoComposer peut recevoir des informations complémentaires via des en-têtes HTTP :

```http
X-GC-Region: PACA
X-GC-Organization: urbanisme
X-GC-Agency: marseille
```

Ces informations :

* ne sont pas définies dans les profils ;
* ne sont pas configurées par GeoComposer ;
* sont transmises par l'infrastructure externe.

GeoComposer peut les exposer aux couches, aux filtres de données ou aux futures règles de sécurité avancées.

La définition fonctionnelle de ces informations est hors du périmètre du système de profils.

---

### Principes de conception

Le système de profils GeoComposer respecte les principes suivants :

* simplicité ;
* séparation entre authentification et autorisation ;
* absence de gestion des utilisateurs ;
* absence de gestion des groupes ;
* profils indépendants du contexte métier ;
* droits définis uniquement par des règles ;
* sélection des layers par liste explicite ou motifs ;
* refus par défaut lorsqu'aucune règle n'autorise l'accès.


Le point encore ouvert est la façon dont les futurs filtres de données exploiteront les en-têtes comme `X-GC-Region` ou `X-GC-Organization`. Nous avons volontairement laissé ce sujet en dehors du système de profils pour éviter les explosions combinatoires du type `dessinateur-paca-urbanisme`.

### __Test avec Basic Auth__

La question de savoir comment ce profil a été obtenu est hors du périmètre de GC.

Cela présente plusieurs avantages :

Déploiement simple

Petit client :

Nginx Basic Auth
    ↓
X-GC-Profile
    ↓
GeoComposer
Déploiement entreprise
Entra ID
    ↓
Keycloak
    ↓
Gateway
    ↓
GeoComposer
Déploiement SaaS
GeoComposer Cloud
    ↓
Votre propre IAM
    ↓
GeoComposer

Le moteur SIG reste identique.

La seule chose que je mettrais quand même dans GC est un mode de confiance configurable.

Par exemple :

security:
  trusted_proxies:
    - 10.0.0.1
    - 10.0.0.2

ou

security:
  trusted_jwt_issuers:
    - https://login.microsoftonline.com/...
    - https://keycloak.company.com

Ainsi GC ne fait pas confiance à n'importe qui.

Je résumerais l'architecture cible ainsi :



## Scalabilité 

Pour GeoComposer, je gérerais la scalabilité avec une règle simple :
le serveur SIG doit être stateless autant que possible.

Architecture cible :
```
              ┌──────────────────┐
              │  Load Balancer   │
              └────────┬─────────┘
                       │
        ┌──────────────┼───────────────┐
        │              │               │
┌───────▼──────┐ ┌─────▼───────┐ ┌─────▼───────┐
│ SIG Server 1 │ │ SIG Server 2│ │ SIG Server 3│
└───────┬──────┘ └─────┬───────┘ └─────┬───────┘
        │              │               │
        └──────┬───────┴──────┬────────┘
               │              │
        ┌──────▼──────┐ ┌─────▼──────┐
        │ PostGIS     │ │ Object     │
        │ / DB        │ │ Storage    │
        └─────────────┘ └────────────┘

``````

La logique :

Élément	Stratégie
Serveur SIG	plusieurs instances stateless
Configuration	stockée en base ou objet versionné
Sessions	JWT ou Redis, pas mémoire locale
Cache tuiles	Redis / disque partagé / S3
Gros fichiers	S3 / Azure Blob / GCS
CDN	devant les tuiles publiques
Jobs lourds	workers séparés
Administration	container séparé, non critique pour le rendu

Je séparerais surtout les traitements :


Pour les tuiles, je ferais :

Niveau 1 — petite installation
PostGIS → GeoComposer → client
Niveau 2 — installation moyenne
PostGIS → GeoComposer → cache local/Redis → client
Niveau 3 — grosse installation
PostGIS → worker pré-génère tuiles → S3 → CDN → client

Dans le modèle Business, vous pouvez vendre précisément les niveaux 2/3 :

cache distribué
workers
S3 / Azure Blob / GCS
CDN
invalidation de cache
Kubernetes
autoscaling
monitoring

C’est une très bonne frontière commerciale : la Community fonctionne sur une VM, la Business scale horizontalement.




Oui, c’est une séparation très propre.

Vous ne bloquez pas artificiellement la Community :

Une publication GeoComposer est un répertoire structuré, versionnable et validable, contenant la configuration, les styles et les assets nécessaires au serveur SIG.

mais si le client n'utilise pas github 

Ce n’est pas un problème : il faut penser Git, pas GitHub.

Le dépôt de configuration peut être :

Option	Compatible
GitHub	oui
GitLab	oui
GitLab self-hosted	oui
Azure DevOps	oui
Bitbucket	oui
Gitea / Forgejo	oui
dépôt Git sur serveur interne SSH	oui
simple dossier versionné localement	oui
aucun Git, juste /config	oui
Donc votre modèle doit être :

GeoComposer Project = répertoire structuré
Git = option de versioning
GitHub = seulement un hébergeur possible
Pour la Community :

/config
  project.yaml
  layers/
  styles/
  assets/
Pour la Business :

Source de vérité :
  - Git quelconque
  - dépôt interne
  - dossier réseau
  - archive publiée
L’extension VS Code ne doit pas dépendre de GitHub. Elle doit travailler sur un répertoire local :

ouvrir dossier geocomposer-project
valider
prévisualiser
publier
Ensuite, si Git est présent, elle peut utiliser Git. Sinon, elle fonctionne quand même en mode filesystem.

La règle produit serait :

GeoComposer Business fournit l’outillage de gestion du projet GeoComposer. Il peut s’intégrer à GitHub, GitLab, Azure DevOps ou à un dépôt Git interne, mais il ne dépend d’aucune plateforme Git spécifique.

------
# BELOW TEXT IS TO BE REFATORED

ok avancons si je veux que le merge alerte les containers configuré sur ce repo, comment on fait (pour que le container se  suicide / une autre sera relance ou pour lui demander un refresh 

Réflexion durant quelques secondes
Oui. Il y a deux bons modèles.

Option A — le container se recharge
C’est le modèle le plus souple.

merge main
   ↓
CI/CD
   ↓
notifie les instances GC
   ↓
GC fait git pull
   ↓
GC valide
   ↓
GC reload atomique
Chaque container garde :

/config
current_commit = abc123
Quand il reçoit :

POST /-/reload
il fait :

git fetch
git checkout main
git pull
gc validate
swap config
Avantage : pas besoin de redémarrer le container.

Inconvénient : le container doit avoir accès au repo Git.

Option B — le container meurt et l’orchestrateur le relance
C’est le modèle le plus “cloud native”.

merge main
   ↓
CI/CD
   ↓
build nouvelle image Docker
   ↓
push image
   ↓
rolling restart
L’image contient :

/app
/config
Donc chaque version de configuration produit une nouvelle image :

geocomposer-server:config-a1b2c3d
Puis Docker Compose / Kubernetes relance les containers.

Avantage : très propre, reproductible, rollback facile.

Inconvénient : il faut reconstruire une image à chaque changement de config.

Je recommande ceci
Community
volume /config
reload manuel
Business simple
CI/CD → POST /-/reload
Business robuste
CI/CD → build image configurée → rolling restart
Pour de la production sérieuse, je préfère Option B :

config Git
  ↓
CI validate
  ↓
build image
  ↓
deploy
Le container ne fait pas git pull. Il exécute une version figée.

Mais pour un serveur unique ou une petite installation, Option A est très pratique.

Le plus important : ne laissez pas GC se suicider tout seul sans orchestration.

Bon :

CI/CD demande à Docker/Kubernetes de redémarrer GC
Moins bon :

GC décide de s’arrêter tout seul
Donc :

reload à chaud si possible
restart orchestré si nécessaire

je serais sur une options dans ce cas de lancement dans le container :
RUN GC --reload-strategy suicide|clone

Oui, mais je changerais les noms.

Plutôt que :

GC --reload-strategy suicide|clone
je proposerais :

gc-server --config-reload=exit|sync
ou :

gc-server --config-source=local|git
gc-server --on-config-change=reload|exit
Parce que suicide est parlant techniquement, mais mauvais comme terme produit/API.

Les deux modes
1. exit
Le container détecte une nouvelle version, puis s’arrête proprement.

merge main
  ↓
GC détecte nouveau commit
  ↓
GC quitte avec code 0 ou code dédié
  ↓
Docker/Kubernetes relance
  ↓
nouvelle config chargée au démarrage
Exemple :

gc-server \
  --config-source git \
  --config-repo https://git.example.com/gc/config.git \
  --config-ref main \
  --on-config-change exit
C’est votre mode “suicide”, mais proprement nommé.

2. sync
Le container garde un clone local et recharge à chaud.

merge main
  ↓
GC détecte nouveau commit
  ↓
git fetch/pull
  ↓
validate
  ↓
reload atomique
Exemple :

gc-server \
  --config-source git \
  --config-repo https://git.example.com/gc/config.git \
  --config-ref main \
  --on-config-change reload
Je séparerais bien deux concepts
D'où vient la config ?
Que faire quand elle change ?
Donc :

--config-source local|git
--on-config-change ignore|reload|exit
Cela couvre plus de cas :

Mode	Source	Changement
Community simple	local	ignore
Dev local	local	reload
Business Git léger	git	reload
Business prod immutable	git	exit
Le mode exit est très sain si Docker/Kubernetes est configuré avec restart policy. Le mode reload est pratique mais plus complexe, car il faut garantir que le rechargement soit atomique.


se sera 1 = Erreur fatale, 2=reload

Oui, ça me paraît propre et suffisant.

0 = arrêt normal
1 = erreur fatale
2 = reload demandé
Du coup :

GC --reload
signifie :

surveille la configuration
si changement :
    exit(2)
Et dans les logs :

[INFO] Configuration revision changed
[INFO] Restart requested
[INFO] Exiting with code 2
C'est également utile pour les scripts de supervision :

case $? in
  0) echo "normal stop" ;;
  1) echo "fatal error" ;;
  2) echo "configuration reload" ;;
esac
Je documenterais même une constante :

enum ExitCode {
    NORMAL = 0,
    FATAL_ERROR = 1,
    RELOAD = 2
}
Ainsi la sémantique est claire et stable pour Docker, Kubernetes, Azure Container Apps ou tout autre orchestrateur.


Doit on gerer des choses particuliere pour le cloud (aujourd'hui) je gère SIGINT et SIGTERM (terminaison demandé)

Oui. Pour le cloud/container, le minimum propre :

SIGTERM / SIGINT
  → arrêter d'accepter de nouvelles requêtes
  → finir les requêtes en cours
  → fermer connexions DB/cache
  → exit(0)

reload détecté
  → log "reload requested"
  → exit(2)

erreur fatale
  → log erreur
  → exit(1)
Ajoutez surtout :

/readiness
Quand SIGTERM arrive :

readiness = false
puis arrêt propre. Ça évite que le load balancer envoie encore du trafic pendant l’arrêt.

Et :

/health
pour dire “le process est vivant”.

Donc :

Cas	Action	Code
SIGTERM / SIGINT	arrêt demandé	0
config changée avec --reload	redémarrage voulu	2
crash / erreur fatale	échec	1
Pour Azure/Kubernetes/Cloud Run, la logique importante est : répondre vite au SIGTERM, passer non-ready, puis terminer proprement.


/readiness ? /health ? c'est des standard cloud ?

Oui, mais plus par convention que par norme officielle.

Vous trouverez très souvent :

/health
/healthz
/live
/livez
et

/ready
/readiness
/readyz
L'idée est de distinguer deux choses.

Vivant (Liveness)
GET /health
répond :

200 OK
tant que le processus fonctionne.

Question :

Le processus est-il bloqué ou planté ?

Prêt (Readiness)
GET /ready
répond :

200 OK
si le serveur est capable de traiter des requêtes.

Question :

Puis-je lui envoyer du trafic ?

Exemple :

Démarrage
    ↓
chargement config
connexion PostGIS
chargement couches
Pendant cette phase :

/health  → 200
/ready   → 503
Quand tout est prêt :

/health  → 200
/ready   → 200
Lors d'un arrêt :

SIGTERM reçu
    ↓
/ready → 503
    ↓
attente fin requêtes
    ↓
exit(0)
Le load balancer arrête alors d'envoyer du trafic avant l'arrêt complet.

Pour GC, je ferais simplement :

GET /health
Réponse :

{
  "status": "alive"
}
et

GET /ready
Réponse :

{
  "status": "ready",
  "configRevision": "abc123"
}
Ce n'est pas obligatoire pour Docker.

Mais pour :

Kubernetes

Azure Container Apps

Azure App Service

AWS ECS

Google Cloud Run

c'est devenu une pratique extrêmement courante.

Je pense que pour GeoComposer :

/health
/ready
suffisent largement.

Pas besoin d'un système plus compliqué.


Peux tu résumer l'ensemble de notre discussion depuis le debut pour que je vois nos conclusions

Voici le résumé des conclusions que nous avons convergées ensemble.

1. Modèle produit
Vous partez sur :

GeoComposer Community
GeoComposer Business
La version Community doit rester pleinement utilisable.

La version Business apporte :

Cloud
DevOps
Administration
Entreprise
et non des limitations artificielles.

2. Séparation des composants
Architecture cible :

+------------------+
| GC Configuration |
+------------------+
         |
         v
+------------------+
|  GC Server       |
+------------------+
Le serveur SIG :

WMS
WMTS
XYZ
MVT
OGC API Features
reste simple.

3. Plus d'administration web obligatoire
L'idée d'un gros backoffice web a évolué vers :

VS Code Extension
comme outil Business.

4. La configuration n'est plus une configuration
C'est probablement la conclusion la plus importante.

Avant :

geocomposer.yaml
Après :

GeoComposer Project
Structure :

project/
├── project.yaml
├── layers/
├── services/
├── styles/
├── assets/
│   ├── icons/
│   ├── sprites/
│   └── fonts/
└── profiles/
Le projet devient l'unité de déploiement.

5. Git devient central
Source de vérité :

GeoComposer Project
       ↓
Git
Avantages :

branches
diff
historique
rollback
audit
CI/CD
Compatible :

GitHub
GitLab
Azure DevOps
Gitea
Forgejo
Bitbucket
Git interne
Aucune dépendance à GitHub.

6. Workflow DevOps
Workflow naturel :

feature branch
    ↓
test local
    ↓
merge main
    ↓
déploiement
Exemple :

branche
    ↓
docker run GC
    ↓
validation
    ↓
merge
7. Community
Configuration :

/config
montée en volume :

volumes:
  - ./config:/config
ou embarquée dans l'image.

8. Business
Même projet :

GeoComposer Project
mais :

Git
VSCode Extension
CI/CD
Cloud Storage
9. Authentification
Grande simplification.

GeoComposer ne gère pas :

utilisateurs
mots de passe
LDAP
MFA
GeoComposer gère :

profils
permissions
politiques d'accès
Exemple :

admin
dessinateur
externe
10. Administration
Seul le module d'administration peut avoir :

admin
Le serveur SIG lui-même n'a pas besoin de connaître des utilisateurs.

11. Profils
Le serveur raisonne uniquement sur :

profil
   ↓
droits
   ↓
couche
Pas sur :

utilisateur
12. Extension VS Code Business
Très bon candidat Business :

validation
preview
publish
rollback
deploy
Tout en gardant :

format ouvert
JSON Schema public
en Community.

13. CI/CD
Vous pouvez fournir :

gc validate
et plus tard :

gc deploy
pour intégrer naturellement :

Azure DevOps
GitHub Actions
GitLab CI
14. Multi-instance
Les instances partagent :

GeoComposer Project
via Git.

Pas besoin de base de configuration.

15. Détection des changements
Mode Git :

GC --config git
Le serveur surveille le dépôt.

16. Reload
Décision finale :

GC --reload
signifie :

si nouveau commit
    exit(2)
Pas de rechargement à chaud.

17. Codes de sortie
Décision retenue :

0 = arrêt normal
1 = erreur fatale
2 = reload demandé
18. Arrêt propre
Déjà présent :

SIGINT
SIGTERM
À conserver.

Comportement :

terminer les requêtes
fermer les connexions
exit(0)
19. Endpoints Cloud
Ajout recommandé :

/health
/ready
Usage :

/health
    process vivant

/ready
    serveur prêt à servir
Très utile pour :

Kubernetes
Azure Container Apps
Cloud Run
ECS
20. Business Features retenues
Les plus pertinentes :

VS Code Extension
Cloud Storage
CDN
OIDC/SAML pour Admin
SQL Server Spatial
Oracle Spatial
Monitoring
Audit
Multi-instance
et non :

gestion complexe des utilisateurs
La conclusion générale est que GeoComposer a progressivement évolué dans notre discussion d'un serveur SIG configurable vers un GeoComposer Project versionné dans Git, piloté par une extension VS Code, intégrable naturellement dans les pipelines DevOps et déployable aussi bien en Community qu'en Business. C'est probablement la décision architecturale la plus structurante qui est ressortie de l'échange.


en fait c'est trop résumé , l'organisation du résumé est OK, mais on perd du contenu , donc reprend la structure mais ne  résume mais rend compte

Très bien. Je vais conserver la structure, mais cette fois en retranscrivant les décisions, les motivations, les alternatives rejetées et les conséquences architecturales.

1. Positionnement produit
L'idée de départ était :

GeoComposer Community
GeoComposer Business
La question était :

Qu'est-ce qu'on met dans la version Business ?

Première intuition :

Cloud Storage
CDN
SQL Server
Oracle
Puis progressivement nous avons convergé vers :

Community
  = moteur SIG complet

Business
  = exploitation cloud
  = administration
  = DevOps
  = intégration entreprise
Conclusion :

Le moteur SIG ne doit pas être amputé.

Un utilisateur Community doit pouvoir :

installer
publier
servir des couches
produire des cartes
sans devoir acheter la version Business.

2. Architecture générale
Au début nous parlions de :

GeoComposer
comme un unique produit.

Puis nous avons convergé vers :

GeoComposer Server
et

GeoComposer Admin
mais ensuite une réflexion plus profonde est apparue :

Le vrai actif n'est peut-être pas l'administration.

Le vrai actif est :

GeoComposer Project
3. Authentification
Nous avons beaucoup tourné autour de :

JWT
OIDC
SAML
Entra ID
Puis vous avez fait remarquer que cela devenait flou.

Nous avons donc repris le problème à la base.

Question :

Est-ce que GeoComposer doit gérer des utilisateurs ?

Réponse finale :

Probablement non.

Nous avons d'abord envisagé :

users
groups
permissions
Puis :

profiles
permissions
Exemple :

admin
dessinateur
externe
L'idée étant :

GeoComposer ne sait pas qui est Mohamed

GeoComposer sait que le profil est :
dessinateur
Nous avons ensuite étudié :

X-GC-Profile: dessinateur
Puis la question :

Comment être sûr que cette valeur est légitime ?

Réponse :

GeoComposer ne peut pas le savoir.

C'est l'infrastructure qui doit être responsable de cela.

Donc :

Reverse Proxy
API Gateway
Portail métier
Keycloak
Entra ID
sont responsables de l'identité.

GeoComposer applique uniquement les permissions.

Conclusion :

GeoComposer Server :

profils
permissions
politiques
mais pas :

utilisateurs
mots de passe
annuaire
Exception :

Le serveur d'administration peut avoir :

admin
comme compte local.

4. La configuration
C'est probablement le point le plus important de toute la discussion.

Au début nous parlions de :

geocomposer.yaml
Puis :

geocomposer.yaml
+
styles
+
icônes
+
sprites
Puis nous avons réalisé que ce n'était plus une configuration.

C'était un projet.

Nous avons donc changé de modèle mental.

Avant :

config principale
+
fichiers référencés
Après :

GeoComposer Project
Exemple :

project/
├── project.yaml
├── layers/
├── services/
├── styles/
├── assets/
│   ├── icons/
│   ├── sprites/
│   └── fonts/
└── profiles/
Conséquence :

Le serveur ne charge plus :

un fichier
mais :

un projet
5. Gestion des versions
Nous avons envisagé :

PostgreSQL
comme stockage de configuration.

Puis :

Cloud Storage
Puis :

Secret Manager
mais ce n'était pas satisfaisant.

Vous avez ensuite précisé :

1. l'admin modifie
2. un administrateur peut modifier à la main
3. historique obligatoire
C'est à ce moment que Git est apparu.

6. Git comme source de vérité
Le dépôt devient :

geocomposer-project
avec :

layers
styles
assets
profiles
services
Versionné dans :

Git
Important :

Nous avons distingué :

Git
et

GitHub
GitHub n'est qu'un hébergeur.

Compatibilité :

GitHub
GitLab
Azure DevOps
Gitea
Forgejo
Bitbucket
Git interne
Conclusion :

GeoComposer ne dépend pas de GitHub.

GeoComposer dépend de Git.

7. Community
Deux modes possibles.

Config embarquée
image Docker
└── config
Très reproductible.

Config montée
volumes:
  - ./config:/config
Simple.

Flexible.

8. Business
Même structure.

Mais la source de vérité est :

Git
Le serveur travaille toujours avec :

/config
localement.

Il n'analyse jamais directement Git pour servir les cartes.

9. Extension VS Code
À l'origine nous pensions :

admin web
Puis nous avons découvert qu'une extension VS Code pourrait être beaucoup plus naturelle.

Elle pourrait :

éditer
valider
prévisualiser
publier
un GeoComposer Project.

Important :

Le format reste ouvert.

Donc :

Community
peut continuer à utiliser :

VSCode
Vim
Notepad++
avec les JSON Schema publics.

La valeur Business devient :

outillage
et non :

format propriétaire
10. DevOps
Nous avons découvert une conséquence importante.

Si le projet est versionné dans Git :

Alors GeoComposer devient naturellement compatible avec :

GitHub Actions
GitLab CI
Azure DevOps
Workflow :

branche
↓
modification
↓
test local
↓
merge
↓
déploiement
Exemple :

feature/add-poi
peut être testé localement.

Puis :

merge main
déclenche la production.

11. Validation
Nous avons évoqué :

gc validate
qui pourrait vérifier :

JSON Schema
références de couches
styles
icônes
assets
permissions
Très utile dans les pipelines CI/CD.

12. Multi-instance
Question :

Comment partager la configuration ?

Au début :

base
cloud storage
Puis nous avons compris :

Le partage est déjà résolu par Git.

Chaque instance possède :

/config
issu d'un clone.

13. Détection des changements
Nous avons étudié plusieurs possibilités.

Reload à chaud
pull
revalidation
swap mémoire
Rejeté car trop complexe.

Suicide
Idée retenue.

Lorsqu'un changement est détecté :

exit
et l'orchestrateur redémarre.

14. Ligne de commande
Après plusieurs itérations :

GC --config local
GC --config git
et :

GC --reload
Sémantique :

surveiller la configuration

si changement :
    exit(2)
15. Codes de sortie
Décision finale :

0 = arrêt normal

1 = erreur fatale

2 = reload demandé
Nous avons explicitement rejeté :

exit(-1)
car sous Unix cela devient :

255
16. Cycle de vie Cloud
Aujourd'hui vous gérez :

SIGINT
SIGTERM
Nous avons conclu que c'était déjà très bien.

Comportement :

finir les requêtes
fermer les ressources
exit(0)
17. Health Checks
Nous avons ajouté :

/health
/ready
/health

répond :

le processus vit
/ready

répond :

je suis prêt à recevoir du trafic
Exemple :

démarrage

/health = OK
/ready = KO
puis :

chargement terminé

/health = OK
/ready = OK



