\set ON_ERROR_STOP on
SELECT format('CREATE ROLE bpa_app_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bpa_app_owner') \gexec
SELECT format('CREATE ROLE bpa_app_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bpa_app_runtime') \gexec
SELECT format('CREATE ROLE bpa_app_reader LOGIN PASSWORD %L', :'reader_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bpa_app_reader') \gexec
ALTER ROLE bpa_app_owner PASSWORD :'owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE bpa_app_runtime PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE bpa_app_reader PASSWORD :'reader_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SELECT 'CREATE DATABASE bpa_app OWNER bpa_app_owner TEMPLATE template0 ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='bpa_app') \gexec
\connect bpa_app
REVOKE ALL ON DATABASE bpa_app FROM PUBLIC;
GRANT CONNECT ON DATABASE bpa_app TO bpa_app_runtime, bpa_app_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO bpa_app_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE bpa_app_owner
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bpa_app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE bpa_app_owner
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO bpa_app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE bpa_app_owner
  GRANT SELECT ON TABLES TO bpa_app_reader;
