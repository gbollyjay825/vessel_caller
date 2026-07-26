const DATABASE_NAME = "vessel-caller";
const DATABASE_VERSION = 2;
const STORE_NAME = "inspection-queue";

export interface QueuedInspection {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  data: Record<string, unknown>;
  evidenceFiles: File[];
  createdAt: string;
  attempts: number;
  operation?: "create" | "update";
  inspectionId?: string;
  finalize?: boolean;
  lastAttemptAt?: string;
  lastError?: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Offline storage is unavailable in this browser"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline storage"));
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      } else if (event.oldVersion < 2) {
        // Version 1 did not bind records to a tenant or user. Those entries
        // cannot be attributed safely and must never be replayed.
        request.transaction?.objectStore(STORE_NAME).clear();
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result: T;
    const request = operation(store);
    request.onsuccess = () => {
      result = request.result;
    };
    const fail = () => {
      database.close();
      reject(tx.error ?? new Error("Offline storage operation failed"));
    };
    tx.oncomplete = () => {
      database.close();
      resolve(result);
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function queueInspection(item: QueuedInspection): Promise<void> {
  if (!item.organizationId || !item.userId) {
    throw new Error("Offline captures require organization and user ownership");
  }
  await transaction<IDBValidKey>("readwrite", (store) => store.put(item));
}

async function allQueuedInspections(): Promise<QueuedInspection[]> {
  const items = await transaction<QueuedInspection[]>("readonly", (store) => store.getAll());
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listQueuedInspectionsForOwner(
  organizationId: string,
  userId: string,
): Promise<QueuedInspection[]> {
  const items = await allQueuedInspections();
  return items.filter((item) => (
    item.organizationId === organizationId && item.userId === userId
  ));
}

async function ownedInspection(
  id: string,
  organizationId: string,
  userId: string,
): Promise<QueuedInspection | undefined> {
  const item = await transaction<QueuedInspection | undefined>("readonly", (store) => store.get(id));
  if (!item) return undefined;
  if (item.organizationId !== organizationId || item.userId !== userId) {
    throw new Error("Offline capture ownership mismatch");
  }
  return item;
}

export async function removeQueuedInspection(
  id: string,
  organizationId: string,
  userId: string,
): Promise<void> {
  if (!await ownedInspection(id, organizationId, userId)) return;
  await transaction<undefined>("readwrite", (store) => store.delete(id));
}

export async function queuedInspectionCount(
  organizationId: string,
  userId: string,
): Promise<number> {
  return (await listQueuedInspectionsForOwner(organizationId, userId)).length;
}

export async function markQueuedInspectionAttempt(
  id: string,
  error: string,
  organizationId: string,
  userId: string,
): Promise<void> {
  const item = await ownedInspection(id, organizationId, userId);
  if (!item) return;
  await queueInspection({
    ...item,
    attempts: item.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
  });
}

export async function clearQueuedInspectionsForOwner(
  organizationId: string,
  userId: string,
): Promise<void> {
  const items = await listQueuedInspectionsForOwner(organizationId, userId);
  await Promise.all(items.map((item) => (
    removeQueuedInspection(item.id, organizationId, userId)
  )));
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `inspection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
