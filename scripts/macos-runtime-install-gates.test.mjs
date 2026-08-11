import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertManagedChromeManifest,
  assertManagedChromeProcessCommand,
  assertManagedChromeSupervisorCommand,
  assertRuntimeMaintenanceReadiness,
  MACOS_MANAGED_CHROME_CONTRACT,
  renderManagedChromeLaunchAgent,
  renderManagedChromeLauncher
} from "./macos-runtime-install-contract.mjs";

function maintenanceStatus(overrides = {}) {
  return {
    schema: "bpa.runtime-maintenance-readiness/1",
    observedAt: "2026-08-10T01:00:00.000Z",
    maintenanceActive: true,
    ready: true,
    blockers: [],
    activity: {
      activeRunCount: 0,
      activeTriggerOccurrenceCount: 2,
      activeTriggerAttemptCount: 0,
      pendingEngineOutboxCount: 0,
      activeControlLeaseCount: 0,
      activeExternalDomainLeaseCount: 0,
      activeStagingLeaseCount: 0,
      activeRecoverySessionCount: 0,
      activeAttentionDeliveryCount: 1,
      terminalRunCount: 12,
      latestTerminalRunAt: "2026-08-10T00:59:00.000Z"
    },
    browser: {
      pendingCancelRequestCount: 0,
      pendingQueueCount: 0,
      activePageProbeCount: 0,
      activeExtensionCommandCount: 0,
      activeExtensionStageCount: 0,
      activeExtensionCancellationCount: 0,
      activeManagedTabReservationCount: 0,
      activePacingReservationCount: 0,
      activeExtensionProbeCount: 0
    },
    delivery: { inFlight: false },
    control: { inFlightMutationCount: 0 },
    teamWorker: { state: "stopped", pendingInvocationCount: 0 },
    ...overrides
  };
}

test("accepts only the exact maintenance readiness projection", () => {
  const ready = maintenanceStatus();
  assert.equal(assertRuntimeMaintenanceReadiness(ready), ready);
  assert.equal(
    assertRuntimeMaintenanceReadiness(
      maintenanceStatus({
        ready: false,
        blockers: ["ACTIVE_RUNS"],
        activity: {
          ...ready.activity,
          activeRunCount: 1
        }
      })
    ).ready,
    false
  );
  assert.throws(
    () => assertRuntimeMaintenanceReadiness({ ...ready, extra: true }),
    /fields are invalid/u
  );
  assert.throws(
    () =>
      assertRuntimeMaintenanceReadiness({
        ...ready,
        ready: true,
        blockers: ["ACTIVE_RUNS"]
      }),
    /blockers are invalid/u
  );
  assert.throws(
    () =>
      assertRuntimeMaintenanceReadiness({
        ...ready,
        activity: { ...ready.activity, activeRunCount: 1 }
      }),
    /do not match live activity/u
  );
  assert.throws(
    () =>
      assertRuntimeMaintenanceReadiness({
        ...ready,
        maintenanceActive: false,
        ready: false,
        blockers: ["MAINTENANCE_LOCK_NOT_HELD"]
      }),
    /identity is invalid/u
  );
});

test("renders one closure-owned managed Chrome Launch Agent", () => {
  const bpaHome = "/Users/test/Library/Application Support/BPA";
  const runtimeRoot = `${bpaHome}/runtime`;
  const logRoot = "/Users/test/Library/Logs/BPA";
  const source = renderManagedChromeLaunchAgent({
    bpaHome,
    runtimeRoot,
    logRoot
  });
  assert.match(source, /<string>com\.bpa\.inventory-chrome<\/string>/u);
  assert.match(
    source,
    /runtime\/current\/bin\/bpa-managed-chrome<\/string>/u
  );
  assert.match(source, /<key>BPA_HOME<\/key>/u);
  assert.doesNotMatch(source, /Google Chrome for Testing|--remote-debugging/u);
  assert.doesNotMatch(source, /yyerybz|apps\/extension/u);
});

test("binds the managed Chrome launcher and live command to one contract", () => {
  assert.equal(
    assertManagedChromeManifest({
      ...MACOS_MANAGED_CHROME_CONTRACT,
      flags: [...MACOS_MANAGED_CHROME_CONTRACT.flags]
    }).schema,
    "bpa.managed-chrome/2"
  );
  assert.equal(
    MACOS_MANAGED_CHROME_CONTRACT.interactionMode,
    "background-extension-only"
  );
  assert.equal(
    MACOS_MANAGED_CHROME_CONTRACT.windowMode,
    "launchservices-hidden"
  );
  assert.throws(
    () =>
      assertManagedChromeManifest({
        ...MACOS_MANAGED_CHROME_CONTRACT,
        remoteDebuggingPort: 17661
      }),
    /differs from the Runtime contract/u
  );
  const releaseIdentity = "v0.6.2-rc.123456789abc.node24.18.0";
  const launcher = renderManagedChromeLauncher(releaseIdentity);
  const syntax = spawnSync("/bin/zsh", ["-n"], {
    input: launcher,
    encoding: "utf8"
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const bpaHome = "/Users/test/Library/Application Support/BPA";
  for (const expected of [
    MACOS_MANAGED_CHROME_CONTRACT.executablePath,
    '/usr/bin/open -gj -n "$APP" --args',
    "/usr/bin/codesign --verify --deep --strict",
    "Identifier=com.google.Chrome",
    "TeamIdentifier=EQHXZ8M8AV",
    "--user-data-dir=$PROFILE",
    "--remote-debugging-port=17660",
    "--remote-debugging-address=127.0.0.1",
    `export BPA_RUNTIME_ID=\"${releaseIdentity}\"`
  ]) {
    assert.ok(launcher.includes(expected), `launcher is missing ${expected}`);
  }
  const command = [
    MACOS_MANAGED_CHROME_CONTRACT.executablePath,
    `--user-data-dir=${bpaHome}/chrome-inventory-profile`,
    "--remote-debugging-port=17660",
    "--remote-debugging-address=127.0.0.1",
    ...MACOS_MANAGED_CHROME_CONTRACT.flags
  ].join(" ");
  assert.doesNotThrow(() =>
    assertManagedChromeProcessCommand(command, bpaHome)
  );
  const runtimeRoot = `${bpaHome}/runtime`;
  assert.doesNotThrow(() =>
    assertManagedChromeSupervisorCommand(
      `/bin/zsh ${runtimeRoot}/current/bin/bpa-managed-chrome`,
      runtimeRoot
    )
  );
  assert.throws(
    () =>
      assertManagedChromeSupervisorCommand(
        `/bin/zsh ${runtimeRoot}/current/bin/bpa-managed-chrome-old`,
        runtimeRoot
      ),
    /differs from the Runtime closure/u
  );
  assert.throws(
    () =>
      assertManagedChromeProcessCommand(
        command.replace("--remote-debugging-port=17660", ""),
        bpaHome
      ),
    /differs from the Runtime closure/u
  );
  assert.throws(
    () =>
      assertManagedChromeProcessCommand(
        command.replace(
          "--remote-debugging-port=17660",
          "--remote-debugging-port=176600"
        ),
        bpaHome
      ),
    /differs from the Runtime closure/u
  );
});

test("writes the exact mode-0600 Launch Agent through the packaged gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "bpa-managed-chrome-gate-"));
  try {
    const manifestPath = join(root, "runtime-manifest.json");
    const statusPath = join(root, "maintenance.json");
    const agentPath = join(root, "com.bpa.inventory-chrome.plist");
    const bpaHome = join(root, "Application Support", "BPA");
    const runtimeRoot = join(bpaHome, "runtime");
    const logRoot = join(root, "Logs", "BPA");
    await writeFile(
      manifestPath,
      JSON.stringify({
        platform: "darwin",
        architecture: "arm64",
        managedChrome: MACOS_MANAGED_CHROME_CONTRACT
      })
    );
    await writeFile(statusPath, JSON.stringify(maintenanceStatus()));
    const gate = new URL("macos-runtime-install-gates.mjs", import.meta.url);
    assert.equal(
      execFileSync(process.execPath, [gate.pathname, "maintenance", statusPath], {
        encoding: "utf8"
      }),
      "ready\n"
    );
    execFileSync(process.execPath, [
      gate.pathname,
      "chrome-write",
      "--manifest",
      manifestPath,
      "--path",
      agentPath,
      "--bpa-home",
      bpaHome,
      "--runtime-root",
      runtimeRoot,
      "--log-root",
      logRoot
    ]);
    assert.equal(
      await readFile(agentPath, "utf8"),
      renderManagedChromeLaunchAgent({ bpaHome, runtimeRoot, logRoot })
    );
    assert.equal((await stat(agentPath)).mode & 0o777, 0o600);
    await chmod(agentPath, 0o644);
    assert.equal((await stat(agentPath)).mode & 0o777, 0o644);
    const invalidMode = spawnSync(process.execPath, [
      gate.pathname,
      "chrome-verify",
      "--manifest",
      manifestPath,
      "--path",
      agentPath,
      "--bpa-home",
      bpaHome,
      "--runtime-root",
      runtimeRoot,
      "--log-root",
      logRoot,
      "--pid",
      String(process.pid)
    ], { encoding: "utf8" });
    assert.notEqual(invalidMode.status, 0);
    assert.match(invalidMode.stderr, /mode is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
