#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

if [ ! -f "$ORACLE_RESTORE_SQL" ]; then
  echo "Missing $ORACLE_RESTORE_SQL" >&2
  exit 1
fi

PREPARED_SQL="$(mktemp "${TMPDIR:-/tmp}/geocomposer-oracle-restore.XXXXXX.sql")"
trap 'rm -f "$PREPARED_SQL"' EXIT
node "$SCRIPT_DIR/prepare-sql.mjs" "$ORACLE_RESTORE_SQL" "$PREPARED_SQL"

bash "$SCRIPT_DIR/wait.sh"

docker exec -i -e NLS_LANG=.AL32UTF8 "$ORACLE_CONTAINER" sqlplus -s "$(oracle_system_connection)" <<SQL
WHENEVER OSERROR EXIT 1
WHENEVER SQLERROR EXIT SQL.SQLCODE
BEGIN
  EXECUTE IMMEDIATE 'DROP USER ${ORACLE_APP_USER} CASCADE';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -1918 THEN
      RAISE;
    END IF;
END;
/

CREATE USER ${ORACLE_APP_USER} IDENTIFIED BY ${ORACLE_APP_PASSWORD} QUOTA UNLIMITED ON USERS;
GRANT CONNECT, RESOURCE TO ${ORACLE_APP_USER};
EXIT;
SQL

docker exec -i -e NLS_LANG=.AL32UTF8 "$ORACLE_CONTAINER" sqlplus -s "$(oracle_app_connection)" <<'SQL'
WHENEVER OSERROR EXIT 1
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,';

CREATE OR REPLACE FUNCTION GC_SDO_ORDINATE_ARRAY(values_text CLOB)
RETURN MDSYS.SDO_ORDINATE_ARRAY
AUTHID CURRENT_USER
IS
  result MDSYS.SDO_ORDINATE_ARRAY := MDSYS.SDO_ORDINATE_ARRAY();
  current_pos PLS_INTEGER := 1;
  comma_pos PLS_INTEGER;
  token VARCHAR2(128);

  PROCEDURE append_token(raw_token VARCHAR2) IS
    clean_token VARCHAR2(128) := TRIM(raw_token);
  BEGIN
    IF clean_token IS NOT NULL THEN
      result.EXTEND;
      result(result.COUNT) := TO_NUMBER(clean_token);
    END IF;
  END;
BEGIN
  LOOP
    comma_pos := DBMS_LOB.INSTR(values_text, ',', current_pos);
    IF comma_pos = 0 THEN
      append_token(DBMS_LOB.SUBSTR(values_text, 128, current_pos));
      EXIT;
    END IF;

    append_token(DBMS_LOB.SUBSTR(values_text, comma_pos - current_pos, current_pos));
    current_pos := comma_pos + 1;
  END LOOP;

  RETURN result;
END;
/

CREATE OR REPLACE FUNCTION GC_SDO_ELEM_INFO_ARRAY(values_text CLOB)
RETURN MDSYS.SDO_ELEM_INFO_ARRAY
AUTHID CURRENT_USER
IS
  result MDSYS.SDO_ELEM_INFO_ARRAY := MDSYS.SDO_ELEM_INFO_ARRAY();
  current_pos PLS_INTEGER := 1;
  comma_pos PLS_INTEGER;
  token VARCHAR2(128);

  PROCEDURE append_token(raw_token VARCHAR2) IS
    clean_token VARCHAR2(128) := TRIM(raw_token);
  BEGIN
    IF clean_token IS NOT NULL THEN
      result.EXTEND;
      result(result.COUNT) := TO_NUMBER(clean_token);
    END IF;
  END;
BEGIN
  LOOP
    comma_pos := DBMS_LOB.INSTR(values_text, ',', current_pos);
    IF comma_pos = 0 THEN
      append_token(DBMS_LOB.SUBSTR(values_text, 128, current_pos));
      EXIT;
    END IF;

    append_token(DBMS_LOB.SUBSTR(values_text, comma_pos - current_pos, current_pos));
    current_pos := comma_pos + 1;
  END LOOP;

  RETURN result;
END;
/
EXIT;
SQL

docker exec "$ORACLE_CONTAINER" mkdir -p "$ORACLE_RESTORE_DIR_PATH"
docker cp "$PREPARED_SQL" "$ORACLE_CONTAINER:$ORACLE_RESTORE_DIR_PATH/world.sql"
docker exec --user 0 "$ORACLE_CONTAINER" chmod 0644 "$ORACLE_RESTORE_DIR_PATH/world.sql"

if grep -Eq '^[[:space:]]*DROP[[:space:]]+TABLE[[:space:]]+WORLD[[:space:]]+PURGE[[:space:]]*;' "$ORACLE_RESTORE_SQL"; then
  docker exec -i -e NLS_LANG=.AL32UTF8 "$ORACLE_CONTAINER" sqlplus -s "$(oracle_app_connection)" <<SQL
WHENEVER OSERROR EXIT 1
WHENEVER SQLERROR EXIT SQL.SQLCODE
DECLARE
  table_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM USER_TABLES
  WHERE TABLE_NAME = 'WORLD';

  IF table_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE TABLE WORLD (ID NUMBER)';
  END IF;
END;
/
EXIT;
SQL
fi

docker exec -i -e NLS_LANG=.AL32UTF8 "$ORACLE_CONTAINER" sqlplus -s "$(oracle_app_connection)" <<SQL
WHENEVER OSERROR EXIT 1
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET DEFINE OFF
ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,';
@${ORACLE_RESTORE_DIR_PATH}/world.sql
DROP FUNCTION GC_SDO_ORDINATE_ARRAY;
DROP FUNCTION GC_SDO_ELEM_INFO_ARRAY;
SELECT COUNT(*) AS WORLD_COUNT FROM WORLD;
EXIT;
SQL

echo "Database restored from $ORACLE_RESTORE_SQL"
