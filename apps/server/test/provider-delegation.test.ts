import { describe, expect, it, vi } from "vitest";
import { createProviderDiscovery, lookupTxt, providerDiscoveryForOrigin } from "../src/discovery/delegation.js";

const signal = () => new AbortController().signal;
const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe("native provider discovery", () => {
  it("skips delegation only for the configured native hostname", async () => {
    const dns = vi.fn(async () => "haili.app");
    const discover = providerDiscoveryForOrigin("https://haili.app", dns);
    expect(await discover("haili.app", signal())).toBeNull();
    expect(dns).not.toHaveBeenCalled();
    for (const domain of ["j4crev.com", "sub.haili.app", "other-provider.app", "nothaili.app"]) {
      const requestSignal = signal();
      expect(await discover(domain, requestSignal)).toBe("haili.app");
      expect(dns).toHaveBeenLastCalledWith(domain, requestSignal);
    }
  });

  it("preserves cancellation and remote DNS failures", async () => {
    const dns = vi.fn(async () => { throw new Error("SERVFAIL"); });
    const discover = providerDiscoveryForOrigin("https://haili.app", dns);
    await expect(discover("haili.app", AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(dns).not.toHaveBeenCalled();
    await expect(discover("j4crev.com", signal())).rejects.toThrow("SERVFAIL");
  });
});

describe("Hail provider DNS delegation", () => {
  it.each([{ records: Array.from({ length: 33 }, () => ["x"]) }, { records: [["x".repeat(8193)]] }])(
    "bounds TXT replies used by discovery and registration", async ({ records }) => {
      await expect(lookupTxt("_hail-domain-verify.example.com", signal(), () => ({ resolveTxt: async () => records, cancel() {} })))
        .rejects.toThrow("size limit");
    });

  it("treats an empty successful TXT answer as absence", async () => {
    const discover = createProviderDiscovery(() => ({ resolveTxt: async () => [], cancel() {} }));
    expect(await discover("j4crev.com", signal())).toBeNull();
  });

  it("joins chunks within one RR and performs no application caching", async () => {
    const resolveTxt = vi.fn(async () => [["v=hail1; prov", "ider=haili.app"]]);
    const discover = createProviderDiscovery(() => ({ resolveTxt, cancel: vi.fn() }));
    expect(await discover("j4crev.com", signal())).toBe("haili.app");
    expect(await discover("j4crev.com", signal())).toBe("haili.app");
    expect(resolveTxt.mock.calls).toEqual([["_hail-provider.j4crev.com"], ["_hail-provider.j4crev.com"]]);
  });

  it.each(["ENODATA", "ENOTFOUND"])("permits legacy discovery on %s", async code => {
    const discover = createProviderDiscovery(() => ({
      resolveTxt: async () => { throw dnsError(code); }, cancel() {},
    }));
    expect(await discover("j4crev.com", signal())).toBeNull();
  });

  it.each(["ETIMEOUT", "ESERVFAIL", "EREFUSED", "ECANCELLED"])("fails closed on %s", async code => {
    const discover = createProviderDiscovery(() => ({
      resolveTxt: async () => { throw dnsError(code); }, cancel() {},
    }));
    await expect(discover("j4crev.com", signal())).rejects.toThrow(code);
  });

  it.each([
    [["v=hail1; provider=haili.app"], ["v=hail1; provider=haili.app"]],
    [["v=hail2; provider=haili.app"]],
    [["unrelated=record"]],
    [["v=hail1; provider=localhost"]],
    [["v=hail1; provider=127.0.0.1"]],
    [["v=hail1; provider=example.local"]],
    [["v=hail1; provider=com"]],
    [["v=hail1; provider=HAILI.APP"]],
    [["v=hail1; provider=haili.app."]],
    [["v=hail1; provider=https://haili.app"]],
    [["v=hail1; provider=haili.app:443"]],
    [["v=hail1; provider=haili.app/path"]],
    [["v=hail1; provider=haili.app; extra=yes"]],
    [["v=hail1; provider=haili.app\n"]],
    [["a".repeat(513)]],
  ].map(records => ({ records })))("rejects malformed, ambiguous, or unsafe records: $records", async ({ records }) => {
    const discover = createProviderDiscovery(() => ({ resolveTxt: async () => records, cancel() {} }));
    await expect(discover("j4crev.com", signal())).rejects.toThrow();
  });

  it("cancels a pending DNS query on deadline without waiting for DNS", async () => {
    const cancel = vi.fn();
    const discover = createProviderDiscovery(() => ({ resolveTxt: () => new Promise(() => {}), cancel }));
    const controller = new AbortController();
    const pending = discover("j4crev.com", controller.signal);
    const assertion = expect(pending).rejects.toThrow("deadline");
    controller.abort(new Error("deadline"));
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not start DNS for an already cancelled request", async () => {
    const create = vi.fn();
    await expect(createProviderDiscovery(create)("j4crev.com", AbortSignal.abort(new Error("cancelled"))))
      .rejects.toThrow("cancelled");
    expect(create).not.toHaveBeenCalled();
  });
});
