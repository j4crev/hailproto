import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { assertFreshPlcReaderHealth, createIndependentPlcObserver } from "../src/plc/observers.js";
import { validatePlcReadEvidence } from "../src/plc/read-evidence.js";

const did = process.env.PUBLIC_PLC_SMOKE_DID;
const live = did ? it : it.skip;

live("resolves one public Hail DID through independent PLC replicas", async () => {
  const readers = [
    createIndependentPlcObserver("https://plc.wtf", "microcosm"),
    createIndependentPlcObserver("https://plc.eurosky.network", "eurosky"),
  ] as const;
  const observations = await Promise.all(readers.map(async reader => {
    const [resolved, audit, health] = await Promise.all([
      reader.resolver.resolve(did!), reader.audit(did!), reader.health!(),
    ]);
    assertFreshPlcReaderHealth(health, new Date());
    return { resolved, checked: await validatePlcReadEvidence(did!, resolved.evidence, audit) };
  }));
  const [first, second] = observations;
  expect(first && second && isDeepStrictEqual(first.checked, second.checked)).toBe(true);
  expect(first!.resolved).toMatchObject({ did,
    identityDidKey: second!.resolved.identityDidKey,
    messagingDidKey: second!.resolved.messagingDidKey,
    serviceBase: second!.resolved.serviceBase });
});
