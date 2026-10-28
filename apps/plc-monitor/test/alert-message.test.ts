import { expect, it } from "vitest";
import { alertMessage } from "../deploy/cloudflare-alert-worker/alert-message.js";
import { operationDetail } from "../src/operation-detail.js";
import type { ExportedOp } from "@did-plc/lib";
const base = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", occurred_at: "2026-01-01T01:00:00Z" };

it("renders enrollment without a recovery alarm or signup-complete claim", () => {
  const message = alertMessage({ ...base, category: "onboarding-enrollment", detail: {} }, "alice@hail.example");
  expect(message.subject).toBe("[Hail PLC] Identity monitoring enrolled: alice@hail.example");
  expect(message.text).toContain("does not confirm that all signup steps are complete");
  expect(message.text).not.toContain("investigate immediately");
  expect(message.text).toContain(base.did);
});

it("renders field impact, disposition and separate directory/detection timestamps", () => {
  const message = alertMessage({ ...base, category: "unexpected-operation", detail: {
    status: "current", operationRecordedAt: "2026-01-01T00:00:00Z", changes: [
      { field: "services.hail", before: { endpoint: "https://old.example/hail" }, after: { endpoint: "https://new.example/hail" } },
    ],
  } });
  expect(message.subject).toContain("messaging service changed");
  expect(message.text).toContain("Currently effective");
  expect(message.text).toContain("Before:"); expect(message.text).toContain("After:");
  expect(message.text).toContain("Operation recorded by directory: 2026-01-01T00:00:00.000Z");
  expect(message.text).toContain("Detected: 2026-01-01T01:00:00.000Z");
  expect(message.text).toContain("boundary for this operation is 2026-01-04T00:00:00.000Z");
  expect(message.text).toContain("does not establish that it was malicious");
});

it("handles older payloads honestly and rejects unsafe account labels", () => {
  const message = alertMessage({ ...base, category: "unexpected-operation", detail: { operationCid: "cid" } }, "alice\r\nBcc: victim");
  expect(message.subject).toContain(base.did); expect(message.subject).not.toContain("Bcc");
  expect(message.text).toContain("Not available"); expect(message.text).toContain("impact cannot be determined");
});

it.each(["coverage-lost", "invalid-operation-log", "export-gap", "monitoring-restored"])("explains %s without implying an identity change", category => {
  const message = alertMessage({ ...base, category, detail: { matchesApprovedState: false } });
  expect(message.text).toContain("What this means"); expect(message.text).toContain("What to do");
  expect(message.text).not.toContain("recovery is time-sensitive");
  if (category === "monitoring-restored") expect(message.text).toContain("still requires review");
});

it("does not equate nullification with a safe current identity", () => {
  const message = alertMessage({ ...base, category: "operation-status", detail: { status: "nullified" } });
  expect(message.subject).toContain("nullified by recovery");
  expect(message.text).toContain("does not establish that the current state is safe");
});

it("compares against the declared parent, preserving key order changes and intermediate operations", () => {
  const op = { type: "plc_operation", rotationKeys: ["one", "two"], verificationMethods: {}, services: {}, alsoKnownAs: [], prev: null, sig: "sig" };
  const genesis = { cid: "genesis", did: base.did, operation: op, nullified: false, createdAt: base.occurred_at } as ExportedOp;
  const changed = { ...genesis, cid: "changed", operation: { ...op, prev: "genesis", rotationKeys: ["two", "one"] } } as ExportedOp;
  const recovered = { ...genesis, cid: "recovered", operation: { ...op, prev: "genesis", alsoKnownAs: ["at://alice.example"] } } as ExportedOp;
  const audit = [genesis, { ...changed, nullified: true }, recovered];
  const detail = operationDetail(audit[1]!, audit, "recovered", "genesis", new Date(base.occurred_at));
  expect(detail.status).toBe("nullified");
  expect(detail.changes).toEqual([{ field: "rotationKeys", before: ["one", "two"], after: ["two", "one"] }]);
  expect(operationDetail(recovered, audit, "recovered", "genesis", new Date()).changes.map(c => c.field)).toEqual(["alsoKnownAs"]);
});
