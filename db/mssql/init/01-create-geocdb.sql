DECLARE @db sysname = N'$(MSSQL_DB)';
DECLARE @login sysname = N'$(MSSQL_APP_USER)';
DECLARE @password nvarchar(256) = N'$(MSSQL_APP_PASSWORD)';
DECLARE @schema sysname = N'$(MSSQL_SCHEMA)';
DECLARE @sql nvarchar(max);

IF DB_ID(@db) IS NULL
BEGIN
    SET @sql = N'CREATE DATABASE ' + QUOTENAME(@db) + N';';
    EXEC(@sql);
END;

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @login)
BEGIN
    SET @sql = N'CREATE LOGIN ' + QUOTENAME(@login)
        + N' WITH PASSWORD = ' + QUOTENAME(@password, '''')
        + N', CHECK_POLICY = OFF;';
    EXEC(@sql);
END;
ELSE
BEGIN
    SET @sql = N'ALTER LOGIN ' + QUOTENAME(@login)
        + N' WITH PASSWORD = ' + QUOTENAME(@password, '''')
        + N', CHECK_POLICY = OFF;';
    EXEC(@sql);
END;

SET @sql = N'
USE ' + QUOTENAME(@db) + N';

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N' + QUOTENAME(@login, '''') + N')
BEGIN
    CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login) + N';
END;
ELSE
BEGIN
    ALTER USER ' + QUOTENAME(@login) + N' WITH LOGIN = ' + QUOTENAME(@login) + N';
END;

IF SCHEMA_ID(N' + QUOTENAME(@schema, '''') + N') IS NULL
BEGIN
    EXEC(N''CREATE SCHEMA ' + QUOTENAME(@schema) + N' AUTHORIZATION ' + QUOTENAME(@login) + N''');
END;

ALTER AUTHORIZATION ON SCHEMA::' + QUOTENAME(@schema) + N' TO ' + QUOTENAME(@login) + N';
ALTER USER ' + QUOTENAME(@login) + N' WITH DEFAULT_SCHEMA = ' + QUOTENAME(@schema) + N';

IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members drm
    JOIN sys.database_principals r ON r.principal_id = drm.role_principal_id
    JOIN sys.database_principals m ON m.principal_id = drm.member_principal_id
    WHERE r.name = N''db_owner'' AND m.name = N' + QUOTENAME(@login, '''') + N'
)
BEGIN
    ALTER ROLE db_owner ADD MEMBER ' + QUOTENAME(@login) + N';
END;
';

EXEC(@sql);
