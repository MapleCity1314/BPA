# Inventory monitor production deployment

Target paths are fixed to `/Users/yyerybz/Codex/BPA` and `~/Library/Application Support/BPA`. Runtime, scheduler, migration, reader, and backup credentials must remain in separate `0600` files; never place credentials in a plist or the repository.

The production directory contract is enforced by `production-layout.sh`:

- application source: `/Users/yyerybz/Codex/BPA`;
- runtime state: `~/Library/Application Support/BPA`;
- PostgreSQL backups: `~/Library/Application Support/BPA/backups/postgres/{daily,weekly}`;
- Core snapshots: `~/Library/Application Support/BPA/backups/core`;
- deployment archives: `~/Library/Application Support/BPA/backups/deploy`;
- encrypted offsite copies: `~/Library/Mobile Documents/com~apple~CloudDocs/BPA/Backups/PostgreSQL`.

Production launchers fail closed when an environment file points outside this layout. Do not place extension builds, application copies, backup folders, or migration archives directly in `/Users/yyerybz`.

The local job enforces 14 daily copies and 8 weekly copies. Its encrypted iCloud
destination is append-only because macOS File Provider permits launchd to create
a unique file but denies directory enumeration, rename, and deletion. Review
offsite retention separately; failure to clean the offsite directory must never
invalidate a verified local backup.

For an older server layout, run `migrate-production-layout.sh` once as `yyerybz`.
The migration is move-only: it preserves existing PostgreSQL dumps, encrypted
iCloud copies, and legacy extension builds under the fixed backup tree before it
updates the `0600` backup environment paths.

1. Install the exact Node `24.18.0` runtime and pnpm `10.32.1`, synchronize this repository into the target directory, and run `pnpm install --frozen-lockfile`.
2. As a PostgreSQL administrator, run `postgres-bootstrap.sql` with three newly generated passwords supplied as psql variables `owner_password`, `runtime_password`, and `reader_password`.
3. Put the owner DSN only in a temporary `0600` migration environment, run `run-component.sh <migration-env> migrate`, then run `postgres-grants.sql` as `bpa_app_owner`. Remove or archive the migration environment outside the runtime directory afterward.
4. Create separate `0600` env files for Core, monitor, scheduler, and backup. Required values are documented by the process startup errors. The runtime service uses `bpa_app_runtime`; review/diagnostic clients use `bpa_app_reader`.
5. Human-publish the exact Node, Adapter, and Workflow YAML assets with `bpa publish ... --yes`. Publication must not be automated.
6. Copy the four plist files to `~/Library/LaunchAgents`, create the log directory, validate with `plutil -lint`, then bootstrap Core, monitor, scheduler, and backup in that order.
7. Verify `127.0.0.1:17650`, the `0600` Unix socket and launch-URL file, the three 30-minute workflows, lease rows, and absence of DingTalk network requests. Read the one-time URL from that file, then access the review page only through `ssh -L 17650:127.0.0.1:17650 yyerybz@<verified-host>`.
8. Before shadow acceptance, run `restore-drill.sh` against an isolated empty drill database and record process-crash, browser-disconnect, and temporary-database-outage evidence.

The scheduler deliberately degrades when either the frozen product-management tab or frozen recent-order tab is unavailable. Login, CAPTCHA, risk-control, shop mismatch, and DOM-contract errors are never treated as a healthy inventory result.

## Independent Feishu inventory report

The inventory report is a separate one-shot launchd job. It does not import the experience-score project, open a browser, share a process, or write to inventory facts. It only reads the BPA application database and posts one interactive card through its own `0600` environment file.

- Label: `com.bpa.inventory-feishu-report`
- Schedule: daily at 09:30 Asia/Shanghai
- Environment: `~/Library/Application Support/BPA/inventory-feishu-report.env`
- Logs: `inventory-feishu-report.out.log` and `inventory-feishu-report.err.log`
- Idempotency: `audit.change_event` target `inventory-daily:<shopId>:<date>`

Set `BPA_FEISHU_INVENTORY_MODE=preview` to render the complete card to stdout without a network request. Production uses `send`. An accepted provider response is recorded only after the webhook returns success; uncertain external writes are not automatically retried.

## Multi-shop configuration

Legacy `BPA_INVENTORY_SHOP_ID` and `BPA_INVENTORY_SHOP_NAME` remain supported for a single shop. For multiple shops, set the same `BPA_INVENTORY_SHOPS_JSON` value in the monitor and scheduler `0600` environment files:

```json
[
  { "id": "shop-1", "name": "一号店", "browserInstanceId": "browser-instance-1" },
  { "id": "shop-2", "name": "二号店", "browserInstanceId": "browser-instance-2" }
]
```

The normal scheduler requires a different dedicated BPA browser profile and
`browserInstanceId` for every concurrently collected shop. Missing, duplicate,
or shared bindings stop that scheduler instead of risking cross-shop collection.

For one authenticated DouDian account that can switch among many shops, the
serialized recovery worker is the supported alternative:

- `com.bpa.inventory-multishop-recovery` runs every 30 minutes and invokes the
  deterministic `production-cycle.ts` runner. It reuses one
  dedicated Chrome-for-Testing profile on loopback CDP port `17660`.
- `production-cycle.ts` takes PostgreSQL and Core Browser Control leases, switches
  only to exact shop names in `BPA_INVENTORY_SHOPS_JSON`, verifies the resulting
  shop header, and persists each product before proceeding.
- The worker maintains exactly one product tab and one order tab. At every
  restore boundary it closes the previous worker tab and creates its single
  replacement, preserving the dedicated browser profile while preventing blank
  DouDian micro-app renderers, drawers, overlays, scroll state, and tab buildup
  from leaking into the next shop.
- Login expiry is terminal for the cycle. The worker writes `auth_required` to
  `run/inventory-multishop-recovery.status.json`, writes per-shop component
  results to `ops.collection_run` / `ops.collection_step`, exits without suspicious
  retries, and leaves the last persisted facts available to the dashboard.
- The status file is atomically replaced with mode `0600` and exposes only
  allowlisted state, shop identity, timestamp, and bounded diagnostics.

Do not enable the legacy scheduler and serialized recovery worker together.
PostgreSQL facts, leases, forecasts, incidents, and dashboard queries remain
isolated by shop ID in either mode. The dashboard exposes only configured shops
and rejects arbitrary shop IDs.

## Notification hold

During data-link acceptance, keep `com.bpa.inventory-feishu-alert` and
`com.bpa.inventory-feishu-report` disabled with launchd and set
`BPA_FEISHU_INVENTORY_MODE=preview`. This gives two independent safeguards:
no scheduled sender process and no network-send mode if a one-shot report is
started manually. Enabling notification delivery is a separate production
change after inventory freshness and risk-event acceptance.
