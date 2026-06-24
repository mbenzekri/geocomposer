SQL Server n'a pas d'équivalent direct au répertoire `/docker-entrypoint-initdb.d` de l'image PostGIS.

L'initialisation est donc exécutée explicitement par :

```bash
npm run init
```

Le script `scripts/init.sh` exécute `init/01-create-geocdb.sql` avec `sqlcmd` et crée la base, le login, l'utilisateur, le schéma et les droits applicatifs.
