export interface ProductionCycleBrowserLease {
  readonly resourceId:string;
  readonly ownerId:string;
  readonly fencingToken:number;
  readonly expiresAt:string;
}

interface BrowserLeaseClient {
  request(
    method:string,
    input:Record<string,unknown>
  ):Promise<ProductionCycleBrowserLease|undefined>;
}

interface AppLeaseRepository {
  releaseLease(input:{
    leaseKey:string;
    holderId:string;
    fencingToken:number;
  }):Promise<void>;
}

interface ClosablePool {
  end():Promise<void>;
}

export const PRODUCTION_CYCLE_LEASE_TTL_SECONDS = 300;
export const PRODUCTION_CYCLE_RENEWAL_SAFETY_MS = 30_000;

function renewalError(result:PromiseSettledResult<unknown>):string|undefined {
  if (result.status === "fulfilled") return undefined;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

export function evaluateProductionCycleRenewal(input:{
  appResult:PromiseSettledResult<boolean>;
  browserResult:PromiseSettledResult<ProductionCycleBrowserLease|undefined>;
  currentBrowserLease:ProductionCycleBrowserLease;
  appLeaseExpiresAtMs:number;
  nowMs:number;
  appTtlSeconds:number;
}):{
  browserLease:ProductionCycleBrowserLease;
  appLeaseExpiresAtMs:number;
  lossReason?:string;
  diagnostic?:string;
} {
  let appLeaseExpiresAtMs = input.appLeaseExpiresAtMs;
  let browserLease = input.currentBrowserLease;
  const diagnostics:string[] = [];
  if (input.appResult.status === "fulfilled") {
    if (!input.appResult.value) {
      return { appLeaseExpiresAtMs,browserLease,lossReason:"APP_LEASE_LOST" };
    }
    appLeaseExpiresAtMs = input.nowMs + input.appTtlSeconds * 1_000;
  } else if (appLeaseExpiresAtMs <= input.nowMs + PRODUCTION_CYCLE_RENEWAL_SAFETY_MS) {
    const diagnostic = renewalError(input.appResult);
    return {
      appLeaseExpiresAtMs,browserLease,
      lossReason:"APP_LEASE_RENEW_UNCONFIRMED",
      ...(diagnostic === undefined ? {} : { diagnostic })
    };
  } else {
    diagnostics.push(`app:${renewalError(input.appResult)}`);
  }
  if (input.browserResult.status === "fulfilled") {
    if (!input.browserResult.value) {
      return {
        appLeaseExpiresAtMs,browserLease,
        lossReason:"BROWSER_CONTROL_LEASE_LOST"
      };
    }
    browserLease = input.browserResult.value;
  } else if (
    Date.parse(browserLease.expiresAt) <=
      input.nowMs + PRODUCTION_CYCLE_RENEWAL_SAFETY_MS
  ) {
    const diagnostic = renewalError(input.browserResult);
    return {
      appLeaseExpiresAtMs,browserLease,
      lossReason:"BROWSER_CONTROL_LEASE_RENEW_UNCONFIRMED",
      ...(diagnostic === undefined ? {} : { diagnostic })
    };
  } else {
    diagnostics.push(`browser:${renewalError(input.browserResult)}`);
  }
  return {
    appLeaseExpiresAtMs,browserLease,
    ...(diagnostics.length === 0 ? {} : {
      diagnostic:`CONTROL_LEASE_RENEW_TRANSIENT:${diagnostics.join(" ")}`.slice(0,1_000)
    })
  };
}

export async function releaseProductionCycleLeases(input:{
  core:BrowserLeaseClient;
  repository:AppLeaseRepository;
  pool:ClosablePool;
  browserResourceId:string;
  holderId:string;
  appLeaseKey:string;
  appFencingToken:number;
  browserFencingToken?:number;
}):Promise<void> {
  if (input.browserFencingToken !== undefined) {
    await input.core.request(
      "browser.control-lease.release",{
        resourceId:input.browserResourceId,
        ownerId:input.holderId,
        fencingToken:input.browserFencingToken
      }
    ).catch(() => undefined);
  }
  await input.repository.releaseLease({
    leaseKey:input.appLeaseKey,
    holderId:input.holderId,
    fencingToken:input.appFencingToken
  }).catch(() => undefined);
  await input.pool.end();
}

export async function acquireBrowserLeaseOrReleaseAppLease(input:{
  core:BrowserLeaseClient;
  repository:AppLeaseRepository;
  pool:ClosablePool;
  browserResourceId:string;
  holderId:string;
  appLeaseKey:string;
  appFencingToken:number;
}):Promise<ProductionCycleBrowserLease> {
  try {
    const lease = await input.core.request(
      "browser.control-lease.acquire",{
        resourceId:input.browserResourceId,
        ownerId:input.holderId,
        ttlSeconds:180
      }
    );
    if (!lease) throw new Error("BROWSER_CONTROL_LEASE_BUSY");
    return lease;
  } catch (error) {
    await releaseProductionCycleLeases(input);
    throw error;
  }
}
