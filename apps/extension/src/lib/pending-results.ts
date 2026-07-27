const DATABASE_NAME = "bpa-bridge";
const STORE_NAME = "pending-results";
const EVIDENCE_STORE_NAME = "pending-evidence";

export interface PendingResult {
  commandId: string;
  commandSeq: number;
  traceId: string;
  payload: Record<string, unknown>;
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

export interface PendingEvidenceChunk {
  id: string;
  evidenceId: string;
  index: number;
  message: Record<string, unknown>;
}

export async function savePendingEvidenceChunk(
  chunk: PendingEvidenceChunk
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      EVIDENCE_STORE_NAME,
      "readwrite"
    );
    transaction.objectStore(EVIDENCE_STORE_NAME).put(chunk);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function removePendingEvidence(evidenceId: string): Promise<void> {
  const database = await openDatabase();
  const chunks = await new Promise<PendingEvidenceChunk[]>(
    (resolve, reject) => {
      const request = database
        .transaction(EVIDENCE_STORE_NAME, "readonly")
        .objectStore(EVIDENCE_STORE_NAME)
        .getAll();
      request.onsuccess = () =>
        resolve(request.result as PendingEvidenceChunk[]);
      request.onerror = () => reject(request.error);
    }
  );
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      EVIDENCE_STORE_NAME,
      "readwrite"
    );
    const store = transaction.objectStore(EVIDENCE_STORE_NAME);
    for (const chunk of chunks) {
      if (chunk.evidenceId === evidenceId) store.delete(chunk.id);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
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
