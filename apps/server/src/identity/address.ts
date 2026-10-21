import { domainToASCII } from "node:url";
import { validatePayload } from "@hailproto/codec";

export function canonicalizeHailAddress(input: string): string {
  const trimmed = input.trim();
  if (trimmed !== input) throw new Error("Hail address must not contain surrounding whitespace");
  const separator = trimmed.indexOf("@");
  if (separator <= 0 || separator !== trimmed.lastIndexOf("@")) {
    throw new Error("Hail address must contain one local part and one domain");
  }

  const localPart = trimmed.slice(0, separator).toLowerCase();
  const domain = domainToASCII(trimmed.slice(separator + 1)).toLowerCase();
  if (!domain) throw new Error("Hail address domain is invalid");

  const canonical = `${localPart}@${domain}`;
  validatePayload("hail.address-binding", {
    version: 1,
    type: "hail.address-binding",
    address: canonical,
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    issued_at: 1,
    expires_at: 2,
    key_id: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-identity",
  });
  return canonical;
}
