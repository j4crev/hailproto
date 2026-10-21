import { randomBytes } from "node:crypto";
import { encodeBase64Url } from "@hailproto/codec";
import { credentialScopes, type AccountApiClient } from "./account-api.js";
import { privateFile, savePrivateBytes } from "./grant-revocation.js";
import { writeState } from "./account-creation.js";

export async function createCredential(client: AccountApiClient, output: string, requested?: string[]) {
  const account = await client.account();
  if (account.migrationState || !account.scopes.includes("credentials:write")) throw new Error("Account cannot issue credentials");
  let saved: Record<string, unknown> | undefined;
  try { saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(output, 16_384))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (saved && (saved.provider !== account.provider || saved.accountId !== account.accountId ||
    typeof saved.token !== "string" || !/^hailp_[A-Za-z0-9_-]{43}$/.test(saved.token))) throw new Error("Credential output belongs to another account or is invalid");
  const scopes = credentialScopes(requested ?? saved?.scopes ?? account.scopes);
  if (saved?.scopes !== undefined && JSON.stringify(credentialScopes(saved.scopes)) !== JSON.stringify(scopes)) {
    throw new Error("Credential retry changed requested scopes");
  }
  if (scopes.some(scope => !account.scopes.includes(scope))) throw new Error("Credential scopes exceed the caller's permissions");
  const token = saved?.token as string | undefined ?? `hailp_${encodeBase64Url(randomBytes(32))}`;
  const pending = { type: "hailp.api-credential", version: 1, provider: account.provider, accountId: account.accountId, token, scopes };
  if (!saved) await savePrivateBytes(output, new TextEncoder().encode(JSON.stringify(pending)));
  else if (saved.scopes === undefined) await writeState(output, pending);
  const inherited = JSON.stringify(scopes) === JSON.stringify(credentialScopes(account.scopes));
  const record = await client.request("/credentials", inherited ? { token } : { token, scopes });
  if (record.type !== "hailp.api-credential" || record.version !== 1 || record.provider !== account.provider ||
    record.accountId !== account.accountId || record.token !== token || typeof record.credentialId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(record.credentialId) ||
    saved?.credentialId !== undefined && saved.credentialId !== record.credentialId ||
    typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt)) ||
    JSON.stringify(credentialScopes(record.scopes)) !== JSON.stringify(scopes)) throw new Error("Credential acknowledgement differs from the saved request");
  await writeState(output, record);
  return { credentialId: record.credentialId, credentialFile: output, scopes, expiresAt: record.expiresAt };
}
