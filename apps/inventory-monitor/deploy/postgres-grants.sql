\set ON_ERROR_STOP on
REVOKE ALL ON SCHEMA source,dataset,inventory,ops,audit,control FROM PUBLIC;
GRANT USAGE ON SCHEMA source,dataset,inventory,ops,audit,control TO bpa_app_runtime,bpa_app_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA source,dataset,inventory,ops,audit,control TO bpa_app_runtime;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA source,dataset,inventory,ops,audit,control TO bpa_app_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA source,dataset,inventory,ops,audit,control TO bpa_app_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA source,dataset,inventory,ops,audit,control
  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO bpa_app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA source,dataset,inventory,ops,audit,control
  GRANT SELECT ON TABLES TO bpa_app_reader;
