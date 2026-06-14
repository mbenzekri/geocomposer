# Oracle restore scripts

Place Oracle restore SQL scripts here.

These files are not executed by the Docker entrypoint. `npm run restore` copies
`world.sql` into the container and executes it as the `GEOCOMPOSER` user after
recreating that schema.
