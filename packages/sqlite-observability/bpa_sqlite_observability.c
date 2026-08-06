#include <stddef.h>
#include "sqlite3ext.h"

SQLITE_EXTENSION_INIT1

static void bpa_result_db_status(
  sqlite3_context *context,
  int operation
) {
  sqlite3 *database = sqlite3_context_db_handle(context);
  sqlite3_int64 current = 0;
  sqlite3_int64 highwater = 0;
  int status = sqlite3_db_status64(
    database,
    operation,
    &current,
    &highwater,
    0
  );
  if (status != SQLITE_OK) {
    sqlite3_result_error_code(context, status);
    return;
  }
  sqlite3_result_int64(context, current);
}

static void bpa_cache_used(
  sqlite3_context *context,
  int argument_count,
  sqlite3_value **arguments
) {
  (void)argument_count;
  (void)arguments;
  bpa_result_db_status(context, SQLITE_DBSTATUS_CACHE_USED);
}

static void bpa_schema_used(
  sqlite3_context *context,
  int argument_count,
  sqlite3_value **arguments
) {
  (void)argument_count;
  (void)arguments;
  bpa_result_db_status(context, SQLITE_DBSTATUS_SCHEMA_USED);
}

static void bpa_statement_used(
  sqlite3_context *context,
  int argument_count,
  sqlite3_value **arguments
) {
  (void)argument_count;
  (void)arguments;
  bpa_result_db_status(context, SQLITE_DBSTATUS_STMT_USED);
}

static int bpa_register(
  sqlite3 *database,
  const char *name,
  void (*function)(sqlite3_context *, int, sqlite3_value **)
) {
  return sqlite3_create_function_v2(
    database,
    name,
    0,
    SQLITE_UTF8 | SQLITE_DIRECTONLY,
    NULL,
    function,
    NULL,
    NULL,
    NULL
  );
}

#if defined(_WIN32)
__declspec(dllexport)
#endif
int sqlite3_bpaobservability_init(
  sqlite3 *database,
  char **error_message,
  const sqlite3_api_routines *api
) {
  int status;
  (void)error_message;
  SQLITE_EXTENSION_INIT2(api);

  status = bpa_register(database, "bpa_sqlite_cache_used", bpa_cache_used);
  if (status != SQLITE_OK) return status;
  status = bpa_register(database, "bpa_sqlite_schema_used", bpa_schema_used);
  if (status != SQLITE_OK) return status;
  return bpa_register(
    database,
    "bpa_sqlite_statement_used",
    bpa_statement_used
  );
}
