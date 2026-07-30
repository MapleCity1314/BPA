import type { PendingEvidenceUpload } from "./evidence-transfer.js";

const DATABASE_NAME = "bpa-bridge";
const STORE_NAME = "pending-results";
const EVIDENCE_STORE_NAME = "pending-evidence";

export interface PendingResult {
  commandId: string;
  commandSeq: number;
  traceId: string;
  payload: Record<string, unknown>;
}

const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function normalizePendingResultForReplay(
  pending: PendingResult
): PendingResult {
  const pageEpoch = pending.payload.page_epoch;
  if (
    typeof pageEpoch === "string" &&
    PROTOCOL_ID_PATTERN.test(pageEpoch)
  ) {
    return pending;
  }
  return {
    ...pending,
    payload: {
      ...pending.payload,
      page_epoch: `replay-${pending.commandSeq}:${pending.commandId}`
    }
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, {
          keyPath: "commandId"
        });
      }
      if (!request.result.objectStoreNames.contains(EVIDENCE_STORE_NAME)) {
        request.result.createObjectStore(EVIDENCE_STORE_NAME, {
          keyPath: "id"
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePendingEvidenceUpload(
  upload: PendingEvidenceUpload
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      EVIDENCE_STORE_NAME,
      "readwrite"
    );
    transaction.objectStore(EVIDENCE_STORE_NAME).put(upload);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function removePendingEvidence(evidenceId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      EVIDENCE_STORE_NAME,
      "readwrite"
    );
    transaction.objectStore(EVIDENCE_STORE_NAME).delete(evidenceId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function listPendingEvidenceUploads(): Promise<
  PendingEvidenceUpload[]
> {
  const database = await openDatabase();
  const values = await new Promise<PendingEvidenceUpload[]>(
    (resolve, reject) => {
      const request = database
        .transaction(EVIDENCE_STORE_NAME, "readonly")
        .objectStore(EVIDENCE_STORE_NAME)
        .getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as unknown[]).filter(
            (candidate): candidate is PendingEvidenceUpload =>
              candidate !== null &&
              typeof candidate === "object" &&
              typeof (candidate as PendingEvidenceUpload).evidenceId ===
                "string" &&
              Array.isArray(
                (candidate as PendingEvidenceUpload).chunkPayloads
              )
          )
        );
      request.onerror = () => reject(request.error);
    }
  );
  database.close();
  return values;
}

export async function savePendingResult(result: PendingResult): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(result);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function removePendingResult(commandId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(commandId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function listPendingResults(): Promise<PendingResult[]> {
  const database = await openDatabase();
  const values = await new Promise<PendingResult[]>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () => resolve(request.result as PendingResult[]);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return values;
}
