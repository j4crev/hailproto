import { domainToASCII } from "node:url";
import { canonicalizeHailAddress } from "../identity/address.js";
export class CustomDomainError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 503, message: string) { super(message); }
}

export function canonicalDomain(input: string): string {
  if (/[\s/@:#?%\\]/u.test(input) || input.length > 1024) throw new CustomDomainError(400, "Enter a domain name.");
  const domain = domainToASCII(input).toLowerCase();
  try { canonicalizeHailAddress(`a@${domain}`); }
  catch { throw new CustomDomainError(400, "Enter a public domain name without a scheme, path, or trailing dot."); }
  return domain;
}

