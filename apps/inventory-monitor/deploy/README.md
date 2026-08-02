# Inventory monitor production deployment

Target paths are fixed to `/Users/yyerybz/Codex/BPA` and `~/Library/Application Support/BPA`. Runtime, scheduler, migration, reader, and backup credentials must remain in separate `0600` files; never place credentials in a plist or the repository.

1. Install the exact Node `24.18.0` runtime and pnpm `10.32.1`, synchronize this repository into the target directory, and run `pnpm install --frozen-lockfile`.
2. As a PostgreSQL administrator, run `postgres-bootstrap.sql` with three newly generated passwords supplied as psql variables `owner_password`, `runtime_password`, and `reader_password`.
3. Put the owner DSN only in a temporary `0600` migration environment, run `run-component.sh <migration-env> migrate`, then run `postgres-grants.sql` as `bpa_app_owner`. Remove or archive the migration environment outside the runtime directory afterward.
4. Create separate `0600` env files for Core, monitor, scheduler, and backup. Required values are documented by the process startup errors. The runtime service uses `bpa_app_runtime`; review/diagnostic clients use `bpa_app_reader`.
5. Human-publish the exact Node, Adapter, and Workflow YAML assets with `bpa publish ... --yes`. Publication must not be automated.
6. Copy the four plist files to `~/Library/LaunchAgents`, create the log directory, validate with `plutil -lint`, then bootstrap Core, monitor, scheduler, and backup in that order.
7. Verify `127.0.0.1:17650`, the `0600` Unix socket and launch-URL file, the three 30-minute workflows, lease rows, and absence of DingTalk network requests. Read the one-time URL from that file, then access the review page only through `ssh -L 17650:127.0.0.1:17650 yyerybz@<verified-host>`.
8. Before shadow acceptance, run `restore-drill.sh` against an isolated empty drill database and record process-crash, browser-disconnect, and temporary-database-outage evidence.

The scheduler deliberately degrades when either the frozen product-management tab or frozen recent-order tab is unavailable. Login, CAPTCHA, risk-control, shop mismatch, and DOM-contract errors are never treated as a healthy inventory result.
