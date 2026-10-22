import { expect, it, vi } from "vitest";

const { bootstrapAccount, request } = vi.hoisted(() => {
  const request = vi.fn(async () => ({ challengeId: "attacker-challenge" }));
  return { request, bootstrapAccount: vi.fn(async () => ({ client: { request } })) };
});
vi.mock("$lib/server/canary.js", () => ({ bootstrapAccount, ORIGIN: "https://example.com" }));

import { POST as options } from "../routes/auth/enroll/options/+server.js";
import { POST as complete } from "../routes/auth/enroll/complete/+server.js";

for (const [handler, path] of [[options, "options"], [complete, "complete"]] as const) {
  it(`disables legacy bootstrap enrollment ${path} without exercising the server credential`, async () => {
    request.mockClear();
    bootstrapAccount.mockClear();
    await expect(handler()).rejects.toMatchObject({ status: 403 });
    expect(bootstrapAccount).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
}
