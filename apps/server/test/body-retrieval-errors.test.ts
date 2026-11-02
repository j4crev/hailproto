import type { SQL } from "bun";
import { describe, expect, it, vi } from "vitest";
import { BodyRepository } from "../src/bodies/repository.js";
import { bodyDigest, bodyFromText } from "../src/bodies/service.js";

const bytes = bodyFromText("Authorized content");
const digest = bodyDigest(bytes);
const tokenHash = new Uint8Array(32).fill(7);
const authorization = { body_digest: digest, sender_account_id: "sender", expires_at: 200, status: "active" };

describe("body storage error authorization boundary", () => {
  it("does not claim authorization when lookup fails", async () => {
    const sql = vi.fn().mockRejectedValue(new Error("lookup unavailable"));
    await expect(new BodyRepository(sql as unknown as SQL).retrieve(digest, tokenHash, 100)).rejects.toThrow();
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "expired", "inactive", "wrong-digest"])("does not access content for %s authorization", async kind => {
    const row = { ...authorization };
    if (kind === "expired") row.expires_at = 99;
    if (kind === "inactive") row.status = "revoked";
    if (kind === "wrong-digest") row.body_digest = new Uint8Array(32);
    const sql = vi.fn().mockResolvedValueOnce(kind === "unknown" ? [] : [row]);
    expect(await new BodyRepository(sql as unknown as SQL).retrieve(digest, tokenHash, 100)).toBeNull();
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it.each(["fence", "content", "integrity"])("preserves retryable failure after authorization: %s", async stage => {
    const sql = vi.fn().mockResolvedValueOnce([authorization]);
    if (stage === "fence") sql.mockRejectedValueOnce(new Error("fence storage unavailable"));
    else {
      sql.mockResolvedValueOnce([]);
      if (stage === "content") sql.mockRejectedValueOnce(new Error("content storage unavailable"));
      else sql.mockResolvedValueOnce([{ body_bytes: bodyFromText("corrupt"), digest, sender_account_id: "sender" }]);
    }
    expect(await new BodyRepository(sql as unknown as SQL).retrieve(digest, tokenHash, 100)).toBe("missing-body");
  });

  it("keeps retired-provider authorization concealed", async () => {
    const sql = vi.fn().mockResolvedValueOnce([authorization]).mockResolvedValueOnce([{ state: "retired" }]);
    expect(await new BodyRepository(sql as unknown as SQL).retrieve(digest, tokenHash, 100)).toBeNull();
    expect(sql).toHaveBeenCalledTimes(2);
  });
});
