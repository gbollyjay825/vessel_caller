import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearQueuedInspectionsForOwner,
  createIdempotencyKey,
  listQueuedInspectionsForOwner,
  markQueuedInspectionAttempt,
  queueInspection,
  queuedInspectionCount,
  removeQueuedInspection,
  type QueuedInspection,
} from "./offlineQueue";

function resetDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("vessel-caller");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Offline queue database is still open"));
  });
}

function queued(id: string, createdAt: string): QueuedInspection {
  return {
    id,
    organizationId: "org-1",
    userId: "user-1",
    data: { callId: `call-${id}`, cargoType: "Liquid" },
    evidenceFiles: [new File([id], `${id}.jpg`, { type: "image/jpeg" })],
    createdAt,
    attempts: 0,
  };
}

describe("offline inspection queue", () => {
  beforeEach(() => resetDatabase());

  it("persists captures and evidence in creation order", async () => {
    await queueInspection(queued("second", "2026-07-26T10:00:02.000Z"));
    await queueInspection(queued("first", "2026-07-26T10:00:01.000Z"));

    expect(await queuedInspectionCount("org-1", "user-1")).toBe(2);
    const items = await listQueuedInspectionsForOwner("org-1", "user-1");
    expect(items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(items[0].data).toEqual({ callId: "call-first", cargoType: "Liquid" });
    expect(items[0].evidenceFiles).toHaveLength(1);
  });

  it("records retry evidence and removes only a confirmed upload", async () => {
    await queueInspection(queued("capture-1", "2026-07-26T10:00:00.000Z"));
    await markQueuedInspectionAttempt(
      "capture-1",
      "blocked:Validation failed",
      "org-1",
      "user-1",
    );

    const [failed] = await listQueuedInspectionsForOwner("org-1", "user-1");
    expect(failed).toMatchObject({
      id: "capture-1",
      attempts: 1,
      lastError: "blocked:Validation failed",
    });
    expect(failed.lastAttemptAt).toEqual(expect.any(String));

    await removeQueuedInspection("capture-1", "org-1", "user-1");
    expect(await queuedInspectionCount("org-1", "user-1")).toBe(0);
  });

  it("isolates tenants and clears only the user who signs out", async () => {
    await queueInspection(queued("owner-a", "2026-07-26T10:00:00.000Z"));
    await queueInspection({
      ...queued("owner-b", "2026-07-26T10:00:01.000Z"),
      organizationId: "org-2",
      userId: "user-2",
    });

    expect(await listQueuedInspectionsForOwner("org-1", "user-1")).toHaveLength(1);
    expect(await listQueuedInspectionsForOwner("org-2", "user-2")).toHaveLength(1);
    await expect(
      removeQueuedInspection("owner-b", "org-1", "user-1"),
    ).rejects.toThrow("ownership mismatch");

    await clearQueuedInspectionsForOwner("org-1", "user-1");
    expect(await listQueuedInspectionsForOwner("org-1", "user-1")).toEqual([]);
    expect(await listQueuedInspectionsForOwner("org-2", "user-2")).toHaveLength(1);
  });

  it("creates unique idempotency keys for safe replay", () => {
    const first = createIdempotencyKey();
    const second = createIdempotencyKey();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(20);
  });
});
