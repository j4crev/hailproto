import { describe, expect, it } from "vitest";

import {
  decodePayload,
  encodePayload,
  type HailAddressBinding,
  HailCodecError,
  type HailEnvelope,
  type HailValue,
  validatePayload,
} from "../src/index.js";
import {
  addressBinding,
  body,
  deliveryStatus,
  envelope,
  grant,
  senderProfile,
} from "./fixtures.js";

describe("payload validation", () => {
  it("round trips a valid address binding", () => {
    const encoded = encodePayload("hail.address-binding", addressBinding);
    expect(decodePayload("hail.address-binding", encoded)).toEqual(addressBinding);
  });

  it("round trips a valid envelope with binary fields", () => {
    const encoded = encodePayload("hail.envelope", envelope);
    expect(decodePayload("hail.envelope", encoded)).toEqual(envelope);
  });

  it("round trips every remaining v0 payload family", () => {
    expect(
      decodePayload(
        "hail.sender-profile",
        encodePayload("hail.sender-profile", senderProfile),
      ),
    ).toEqual(senderProfile);
    expect(
      decodePayload("hail.grant", encodePayload("hail.grant", grant)),
    ).toEqual(grant);
    expect(
      decodePayload(
        "hail.delivery-status",
        encodePayload("hail.delivery-status", deliveryStatus),
      ),
    ).toEqual(deliveryStatus);
    expect(
      decodePayload("hail.body.spt-1", encodePayload("hail.body.spt-1", body)),
    ).toEqual(body);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      encodePayload(
        "hail.address-binding",
        { ...addressBinding, surprise: true } as unknown as HailAddressBinding,
      ),
    ).toThrow(HailCodecError);
  });

  it("rejects text where an envelope digest requires bytes", () => {
    const invalid = structuredClone(envelope);
    const digest = invalid.body.digest as unknown as Record<string, HailValue>;
    digest.value = "not-binary";
    expect(() =>
      encodePayload("hail.envelope", invalid as unknown as HailEnvelope),
    ).toThrow(HailCodecError);
  });

  it("rejects a delivery reason that is invalid for its state", () => {
    const invalid = {
      ...deliveryStatus,
      state: "failed",
      reason: "sender-unreachable",
    } as unknown as typeof deliveryStatus;
    expect(() => encodePayload("hail.delivery-status", invalid)).toThrow(
      HailCodecError,
    );
  });

  it("rejects unsupported body versions", () => {
    const invalid = { ...body, version: 2 } as unknown as typeof body;
    expect(() => encodePayload("hail.body.spt-1", invalid)).toThrow(HailCodecError);
  });

  it("rejects explicit undefined optional values during direct validation", () => {
    const invalid = { ...envelope, reply_to: undefined };
    expect(() => validatePayload("hail.envelope", invalid)).toThrow(
      /unsupported Hail value/,
    );
  });

  it("rejects accepted delivery status after revision 1", () => {
    const invalid = {
      ...deliveryStatus,
      revision: 2,
      state: "accepted",
    } as unknown as typeof deliveryStatus;
    expect(() => encodePayload("hail.delivery-status", invalid)).toThrow(
      HailCodecError,
    );
  });

  it("rejects addresses without a recognized public suffix", () => {
    const invalid = {
      ...addressBinding,
      address: "alice@example.invalid",
    } as unknown as HailAddressBinding;
    expect(() => encodePayload("hail.address-binding", invalid)).toThrow(
      /public suffix/,
    );
  });

  it("rejects a domain that is itself a private public suffix", () => {
    const invalid = {
      ...addressBinding,
      address: "alice@github.io",
    } as unknown as HailAddressBinding;
    expect(() => encodePayload("hail.address-binding", invalid)).toThrow(
      /public suffix/,
    );
  });

  it("accepts registrable domains beneath private public suffixes", () => {
    const valid = {
      ...addressBinding,
      address: "alice@project.github.io",
    } as HailAddressBinding;
    expect(() => encodePayload("hail.address-binding", valid)).not.toThrow();
  });

  it("rejects malformed IDNA address domains", () => {
    const invalid = {
      ...addressBinding,
      address: "alice@xn--a.example",
    } as unknown as HailAddressBinding;
    expect(() => encodePayload("hail.address-binding", invalid)).toThrow(/IDNA/);
  });

  it("accepts LDH-style address local parts", () => {
    for (const local of ["xn--alice--2.dev", "a".repeat(63)]) {
      const valid = {
        ...addressBinding,
        address: `${local}@example.com`,
      } as HailAddressBinding;
      expect(() => encodePayload("hail.address-binding", valid)).not.toThrow();
    }
  });

  it.each(["alice+tag", "-alice", "alice-", "alice..dev", "a".repeat(64)])(
    "rejects non-LDH address local part %s",
    (local) => {
      const invalid = {
        ...addressBinding,
        address: `${local}@example.com`,
      } as unknown as HailAddressBinding;
      expect(() => encodePayload("hail.address-binding", invalid)).toThrow(
        /Hail address/,
      );
    },
  );
});
