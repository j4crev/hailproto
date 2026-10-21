import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import { AccountApiClient, credentialScopes } from "./account-api.js";
import { privateFile, savePrivateBytes } from "./grant-revocation.js";
import { writeState } from "./account-creation.js";
import { unlockUserIdentity, unlockUserVault, type UserVaultFile } from "./vault.js";
import { accountAccessInput, type AccountAccessChallenge } from "./account-access-proof.js";
import { readRecoverySecret } from "./cli/private-input.js";

interface LoginState {
  type: "hailp.account-login"; version: 1; provider: string; did: string;
  signer: "identity" | "owner-recovery"; publicKey: string; scopes: string[]; token: string; createdAt: number;
  challenge?: AccountAccessChallenge; signature?: string;
}
export async function loginAccount(provider: string, did: string, signer: LoginState["signer"], requestedScopes: string[],
  vaultPath: string, statePath: string, output: string, recoveryInput: () => Promise<string> = readRecoverySecret) {
  if (new Set([vaultPath, statePath, output].map(path => resolve(path))).size !== 3 ||
    !/^did:plc:[a-z2-7]{24}$/.test(did) || !["identity", "owner-recovery"].includes(signer)) throw new Error("Login requires distinct private paths and an explicit DID/signer");
  const scopes = credentialScopes(requestedScopes);
  const vault = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(vaultPath, 16_384))) as UserVaultFile;
  if (vault.did !== did) throw new Error("Login DID differs from the owner vault");
  const publicKey = signer === "identity" ? vault.identity.publicDidKey : vault.recovery.publicDidKey;
  let state: LoginState;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(statePath, 16_384))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try { await privateFile(output, 16_384); throw new Error("Login output already exists without its original state"); }
    catch (existing) { if (!(existing instanceof Error && "code" in existing && existing.code === "ENOENT")) throw existing; }
    state = { type: "hailp.account-login", version: 1, provider, did, signer, publicKey, scopes,
      token: `hailp_${encodeBase64Url(randomBytes(32))}`, createdAt: Math.floor(Date.now() / 1000) };
    AccountApiClient.signup(provider, state.token); // Validate origin before writing secrets or contacting it.
    await savePrivateBytes(statePath, new TextEncoder().encode(JSON.stringify(state)));
  }
  if (!state || state.type !== "hailp.account-login" || state.version !== 1 || state.provider !== provider || state.did !== did ||
    state.signer !== signer || state.publicKey !== publicKey || JSON.stringify(credentialScopes(state.scopes)) !== JSON.stringify(scopes) ||
    !Number.isSafeInteger(state.createdAt) || state.createdAt > Math.floor(Date.now() / 1000) + 30 ||
    Math.floor(Date.now() / 1000) - state.createdAt >= 300) throw new Error("Login state differs or expired; retain it and start a deliberate new attempt with new paths");
  const client = AccountApiClient.signup(provider, state.token);
  const tokenHash = encodeBase64Url(new Uint8Array(createHash("sha256").update(state.token).digest()));
  const secret = decodeBase64Url(await recoveryInput());
  try {
    // Unlock before asking for a challenge; an unavailable signer never selects recovery/provider custody.
    const user = signer === "identity" ? await unlockUserIdentity(vault, secret) : await unlockUserVault(vault, secret);
    const challenge = state.challenge ?? await client.request("/prepare", { did, signer, publicKey, scopes, tokenHash }, "/api/v1/account-access") as unknown as AccountAccessChallenge;
    accountAccessInput(challenge);
    const now = Math.floor(Date.now() / 1000);
    if (challenge.provider !== provider || challenge.did !== did || challenge.signer !== signer || challenge.publicKey !== publicKey ||
      challenge.tokenHash !== tokenHash || JSON.stringify(challenge.scopes) !== JSON.stringify(scopes) ||
      challenge.issuedAt > now + 30 || challenge.issuedAt < state.createdAt - 30 || challenge.expiresAt <= now) throw new Error("Challenge differs from the reviewed login or expired");
    state.challenge = challenge; await writeState(statePath, state);
    if (!state.signature) {
      state.signature = encodeBase64Url(signer === "identity" ? await (user as Awaited<ReturnType<typeof unlockUserIdentity>>).signAccountAccess(challenge) :
        await (user as Awaited<ReturnType<typeof unlockUserVault>>).signAccountRecovery(challenge));
      await writeState(statePath, state);
    }
    const result = await client.request("/complete", { challengeId: challenge.challengeId, token: state.token, signature: state.signature }, "/api/v1/account-access");
    const credential = result.credential as Record<string, unknown>;
    if (!credential || credential.type !== "hailp.api-credential" || credential.version !== 1 || credential.provider !== provider ||
      credential.accountId !== challenge.accountId || credential.token !== state.token || typeof credential.credentialId !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(credential.credentialId) ||
      typeof credential.expiresAt !== "string" || !Number.isFinite(Date.parse(credential.expiresAt)) ||
      JSON.stringify(credentialScopes(credential.scopes)) !== JSON.stringify(scopes)) throw new Error("Login acknowledgement differs from the signed request");
    try { await savePrivateBytes(output, new TextEncoder().encode(JSON.stringify(credential))); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(output, 16_384)));
      if (JSON.stringify(saved) !== JSON.stringify(credential)) throw new Error("Login output conflicts with the issued credential");
    }
    return { credentialId: credential.credentialId, credentialFile: output, scopes, expiresAt: credential.expiresAt, did, signer };
  } finally { secret.fill(0); }
}
