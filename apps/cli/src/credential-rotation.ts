import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { encodeBase64Url } from "@hailproto/codec";
import { AccountApiClient, AccountApiError, credentialScopes, type AccountApiScope } from "./account-api.js";
import { privateFile, savePrivateBytes } from "./grant-revocation.js";
import { writeState } from "./account-creation.js";
import { createCredential } from "./credential-creation.js";

interface RotationState {
  type: "hailp.credential-rotation"; version: 1; provider: string; accountId: string;
  sourceCredentialId: string; sourceTokenHash: string; token: string; scopes: AccountApiScope[];
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const sameScopes = (a: unknown, b: unknown) => JSON.stringify(credentialScopes(a)) === JSON.stringify(credentialScopes(b));

export async function rotateCredential(source: string, output: string) {
  if (resolve(source) === resolve(output)) throw new Error("Rotation requires a new credential output path");
  const original = await AccountApiClient.fromCredentialFile(source);
  const sourceRecord = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(source, 16_384)));
  const statePath = `${output}.rotation.json`;
  let state: RotationState;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(statePath, 16_384))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try { await privateFile(output, 16_384); throw new Error("Rotation output already exists without its original state"); }
    catch (existing) { if (!(existing instanceof Error && "code" in existing && existing.code === "ENOENT")) throw existing; }
    const account = await original.account();
    if (!account.credential) throw new Error("Provider must expose current credential metadata for rotation");
    if (account.credential.credentialId !== sourceRecord.credentialId) throw new Error("Source credential ID differs from the authenticated credential");
    if (account.migrationState || !account.scopes.includes("credentials:write")) throw new Error("Account cannot rotate credentials");
    if (!sameScopes(account.scopes, sourceRecord.scopes)) throw new Error("Source credential scopes differ from its authenticated permissions");
    state = { type: "hailp.credential-rotation", version: 1, provider: account.provider, accountId: account.accountId,
      sourceCredentialId: account.credential.credentialId, sourceTokenHash: hash(sourceRecord.token),
      token: `hailp_${encodeBase64Url(randomBytes(32))}`, scopes: credentialScopes(account.scopes) };
    await savePrivateBytes(statePath, new TextEncoder().encode(JSON.stringify(state)));
  }
  if (!state || state.type !== "hailp.credential-rotation" || state.version !== 1 ||
    state.provider !== sourceRecord.provider || state.accountId !== sourceRecord.accountId ||
    state.sourceCredentialId !== sourceRecord.credentialId || state.sourceTokenHash !== hash(sourceRecord.token) ||
    !sameScopes(state.scopes, sourceRecord.scopes) ||
    typeof state.token !== "string" || !/^hailp_[A-Za-z0-9_-]{43}$/.test(state.token) || state.token === sourceRecord.token ||
    !credentialScopes(state.scopes).includes("credentials:write")) throw new Error("Rotation state does not match the original credential");
  const pending = { type: "hailp.api-credential", version: 1, provider: state.provider,
    accountId: state.accountId, token: state.token, scopes: state.scopes };
  try {
    const saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(output, 16_384)));
    if (saved.provider !== state.provider || saved.accountId !== state.accountId || saved.token !== state.token ||
      !sameScopes(saved.scopes, state.scopes)) throw new Error("Rotation output conflicts with its saved request");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await savePrivateBytes(output, new TextEncoder().encode(JSON.stringify(pending)));
  }
  let replacement = await AccountApiClient.fromCredentialFile(output);
  let account;
  try { account = await replacement.account(); }
  catch (error) {
    if (!(error instanceof AccountApiError && error.status === 401)) throw error;
    await createCredential(original, output, state.scopes);
    replacement = await AccountApiClient.fromCredentialFile(output);
    account = await replacement.account();
  }
  if (!account.credential || account.credential.credentialId === state.sourceCredentialId || account.migrationState ||
    !sameScopes(account.scopes, state.scopes)) throw new Error("Replacement credential does not match the reviewed rotation");
  const completed = { ...pending, credentialId: account.credential.credentialId,
    scopes: credentialScopes(account.scopes), expiresAt: account.credential.expiresAt };
  await writeState(output, completed);
  const revoked = await replacement.request("/credentials", { revoke: state.sourceCredentialId });
  if (revoked.revoked !== true) throw new Error("Provider did not acknowledge original credential revocation");
  return { credentialId: completed.credentialId, credentialFile: output, scopes: completed.scopes,
    expiresAt: completed.expiresAt, rotatedFrom: state.sourceCredentialId, revoked: true };
}
