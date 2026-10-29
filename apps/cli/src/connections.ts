import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { encodeBase64Url, decodeBase64Url, encodeDeterministic, fromDiagnosticJson, inspectSignedPayload, type DiagnosticJson } from "@hailproto/codec";
import type { AccountApiClient } from "./account-api.js";
import { privateFile, savePrivateBytes } from "./grant-revocation.js";
import { signConnectionProposal } from "./connection-signing.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DID = /^did:plc:[a-z2-7]{24}$/;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type ObjectValue = Record<string, unknown>;
type State = { type: "hailp.connection-state"; version: 1; provider: string; accountId: string; did: string; request: ObjectValue & { requestId: string } };
async function optionalFile(path: string, limit: number) {
  try { return await privateFile(path, limit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function saveExact(path: string, value: unknown) {
  const existing = await optionalFile(path, 65536);
  if (existing) { if (!isDeepStrictEqual(JSON.parse(new TextDecoder().decode(existing)), value)) throw new Error("Retained Connection artifact conflicts; keep the original files"); }
  else await savePrivateBytes(path, bytes(value));
}
function invitation(value: unknown) {
  const code = value as { type: string; version: number; id: string; did: string; token: string };
  if (!code || Object.keys(code).sort().join(",") !== "did,id,token,type,version" || code.type !== "hailp.connection-invitation" || code.version !== 1 ||
    !UUID.test(code.id) || !DID.test(code.did) || typeof code.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code.token) || encodeBase64Url(decodeBase64Url(code.token,32)) !== code.token)
    throw new Error("Expected a private Hail Connection invitation file");
  return code;
}
async function selectedState(client: AccountApiClient, path: string, input?: ObjectValue): Promise<State> {
  const account = await client.account();
  if (account.migrationState || account.custodyProfile !== "owner-controlled" || !account.scopes.includes("account:write"))
    throw new Error("Connection consent requires owner-controlled custody and account:read/account:write; managed consent requires a browser passkey");
  const existing = await optionalFile(path, 65536);
  if (existing) {
    const state = JSON.parse(new TextDecoder().decode(existing)) as State;
    if (state.type !== "hailp.connection-state" || state.version !== 1 || state.provider !== account.provider || state.accountId !== account.accountId || state.did !== account.did ||
      !state.request || !UUID.test(state.request.requestId)) throw new Error("Connection state belongs to another account or request");
    const { requestId, ...saved } = state.request;
    if (input && !isDeepStrictEqual(saved, input)) throw new Error("Connection retry changed its intent; retain the original state and inputs");
    return state;
  }
  if (!input) throw new Error("Connection state file does not exist");
  const state: State = { type: "hailp.connection-state", version: 1, provider: account.provider, accountId: account.accountId, did: account.did,
    request: { requestId: randomUUID(), ...input } };
  await savePrivateBytes(path, bytes(state));
  return state;
}
function summary(state: State, response: ObjectValue) {
  if (response.requestId !== state.request.requestId || response.action !== state.request.action || !response.review || typeof response.review !== "object")
    throw new Error("Provider returned another Connection approval");
  const review = response.review as ObjectValue;
  if (state.request.action === "create" ? review.label !== state.request.label || review.expiresAt !== state.request.expiresAt || review.personal !== false :
    review.id !== state.request.id || review.did !== state.request.did) throw new Error("Connection review differs from the requested intent");
  return response;
}
async function consent(client: AccountApiClient, statePath: string, vault: string, input: ObjectValue) {
  const state = await selectedState(client, statePath, input);
  let response = summary(state, await client.request("/connections/cli-prepare", state.request));
  if (!response.result) {
    const proposal = response.ownerSigning as ObjectValue;
    if (!proposal || proposal.requestId !== state.request.requestId || proposal.provider !== state.provider) throw new Error("Provider did not supply the expected owner signing proposal");
    const type = input.action === "create" ? "hail.connection-invitation" : "hail.connection-confirmation";
    const payload = fromDiagnosticJson(type, proposal.payload as DiagnosticJson);
    if (payload.from !== state.did || payload.key_id !== state.did + "#hail-identity" ||
      (payload.type === "hail.connection-invitation" ? payload.expires_at !== input.expiresAt : payload.to !== input.did || payload.invitation_id !== input.id))
      throw new Error("Provider proposed consent for another identity, invitation, or expiry");
    await saveExact(statePath + ".proposal.json", proposal);
    let signed = await optionalFile(statePath + ".cose", 16384);
    if (!signed) {
      await signConnectionProposal(vault, statePath + ".proposal.json", statePath + ".cose", state.provider,process.stdin.isTTY===true);
      signed = await privateFile(statePath + ".cose", 16384);
    }
    if (!Buffer.from(encodeDeterministic(inspectSignedPayload(type, signed).payload as never)).equals(Buffer.from(encodeDeterministic(payload as never))))
      throw new Error("Retained Connection signature does not match the reviewed consent");
    response = summary(state, await client.request("/connections/cli-commit", { requestId: state.request.requestId, cose: encodeBase64Url(signed) }));
  }
  return { state, response };
}
export async function inviteConnection(client: AccountApiClient, label: string, expiresAt: number, vault: string, statePath: string, output: string) {
  const { state, response } = await consent(client, statePath, vault, { action: "create", personal: false, label, expiresAt });
  const code = invitation(response.invitation), result = response.result as ObjectValue;
  if (code.did !== state.did || code.id !== result?.invitationId) throw new Error("Invitation differs from the created consent");
  const proposal = JSON.parse(new TextDecoder().decode(await privateFile(statePath + ".proposal.json", 32768)));
  const payload = fromDiagnosticJson("hail.connection-invitation", proposal.payload);
  if (payload.invitation_id !== code.id || !Buffer.from(payload.token_hash.value).equals(createHash("sha256").update(decodeBase64Url(code.token,32)).digest()))
    throw new Error("Invitation token does not match the locally signed consent");
  await saveExact(output, code);
  // Admission capability stays in the private output, never stdout or command arguments.
  return { requestId: state.request.requestId, invitationId: code.id, did: code.did, expiresAt, invitationFile: output };
}
export async function acceptConnection(client: AccountApiClient, file: string, expectedDid: string, vault: string, statePath: string) {
  const code = invitation(JSON.parse(new TextDecoder().decode(await privateFile(file,16384))));
  if (!DID.test(expectedDid) || code.did !== expectedDid) throw new Error("Invitation does not match the expected peer DID");
  const { state, response } = await consent(client, statePath, vault, { action: "connect", id: code.id, did: code.did, token: code.token });
  return connectionResult(state, response);
}
function connectionResult(state: State, response: ObjectValue) {
  const result = response.result as ObjectValue | null;
  if (state.request.action === "create") return { requestId: state.request.requestId, action: "create", invitationId: result?.invitationId ?? null, state: result ? "created" : "awaiting-signature" };
  if (result && (typeof result.attemptId !== "string" || !UUID.test(result.attemptId) ||
    !["connecting", "active", "expired", "conflict"].includes(result.state as string) || result.connectionId !== null && (typeof result.connectionId !== "string" || !UUID.test(result.connectionId))))
    throw new Error("Invalid Connection admission result");
  return { requestId: state.request.requestId, peerDid: state.request.did, attemptId:result?.attemptId??null,
    state:result?.state??"awaiting-signature",connectionId:result?.connectionId??null };
}
export async function connectionStatus(client: AccountApiClient, statePath: string) {
  const state = await selectedState(client, statePath);
  return connectionResult(state, summary(state, await client.request(`/connections/cli-status?requestId=${state.request.requestId}`)));
}
