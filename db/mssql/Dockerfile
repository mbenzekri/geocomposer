FROM mcr.microsoft.com/mssql/server:2022-latest

USER root

RUN mkdir -p /var/opt/mssql/backups \
    && chown -R mssql:mssql /var/opt/mssql/backups \
    && chmod 775 /var/opt/mssql/backups

USER mssql