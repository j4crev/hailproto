import { parseArgs } from "node:util";
import { ClientError as CliError } from "../client-error.js";

const options = {
  credentials: { type: "string" }, provider: { type: "string" }, "account-id": { type: "string" },
  vault: { type: "string" }, output: { type: "string" }, state: { type: "string" },
  category: { type: "string", multiple: true }, scope: { type: "string", multiple: true },
  after: { type: "string" }, pages: { type: "string" }, wait: { type: "string" }, interval: { type: "string" },
  "expires-at": { type: "string" }, "reply-until": { type: "string" }, "expected-did": { type: "string" },
  "refresh-consent": { type: "boolean" }, "no-expiry": { type: "boolean" }, uncategorized: { type: "boolean" },
  "backup-verified": { type: "boolean" }, "recovery-file": { type: "string" },
  sender: { type: "string" }, address: { type: "string" }, custody: { type: "string" },
  file: { type: "string" }, grant: { type: "string" }, did: { type: "string" }, signer: { type: "string" },
  destination: { type: "string" }, username: { type: "string" }, snapshot: { type: "string" },
  consent: { type: "string" }, operation: { type: "string" }, binding: { type: "string" },
  approval: { type: "string" },
  "monitor-origin": { type: "string" }, "monitor-key": { type: "string" }, "monitor-attestation": { type: "string" },
  help: { type: "boolean", short: "h" }, version: { type: "boolean" },
} as const;

// One command table owns help, option allowlists and required arguments.
const commands = [
  ["account show", "", "", "", true, "Read the selected account and current credential metadata."],
  ["account create", "", "provider address custody vault state credentials backup-verified", "monitor-origin monitor-key monitor-attestation", false, "Resumable owner-signed signup; public mode pauses for reviewed monitor enrollment."],
  ["account login", "", "provider did signer vault state credentials scope", "", false, "Issue fresh access using explicit identity or owner-recovery proof."],
  ["account transfer offer", "", "destination vault state", "", true, "Sign/review one exact destination Offer with identity only."],
  ["account transfer status", "", "", "", true, "Read retained source transfer state; expiry never releases a fence."],
  ["account transfer select", "", "username vault state", "", true, "Reserve an address; this can fence the source and block normal writes."],
  ["account transfer cancel", "", "vault state", "", true, "Sign pre-fence cancellation and obtain target cleanup acknowledgement."],
  ["account transfer export", "", "state output", "", true, "Advance a fenced source to exported and retain its immutable signed snapshot."],
  ["account transfer sign-cutover", "", "vault state snapshot consent operation binding", "", false, "Offline full-vault signing; retain the exact PLC operation, consent and binding."],
  ["account transfer complete", "", "state snapshot", "", false, "Submit retained artifacts, activate destination and retire source; no bearer or key unlock."],
  ["account managed-transfer offer", "", "destination vault state", "", true, "Owner-authorize a managed move and retain the exact destination Offer."],
  ["account managed-transfer status", "", "", "", true, "Read retained managed-transfer handshake state."],
  ["account managed-transfer select", "", "username vault state", "", true, "Owner-select and reserve the destination address; this can fence the source."],
  ["account managed-transfer export", "", "state output", "", true, "Export and retain the exact signed managed snapshot after fencing."],
  ["account managed-transfer sign-cutover", "", "vault state snapshot operation approval", "", false, "Owner-sign the exact managed PLC cutover and snapshot approval offline."],
  ["account managed-transfer complete", "", "state snapshot", "monitor-attestation", false, "Stage, cut over, activate and retire; public mode requires independent monitor evidence."],
  ["account custody managed", "", "state", "vault", true, "Rotate owner-controlled identity into same-provider managed custody; retain state for exact retries."],
  ["account custody owner-controlled", "", "vault state backup-verified", "", true, "Rotate managed identity into fresh client-held custody; verify backup and retain exact retry state."],
  ["vault create", "", "vault recovery-file", "", false, "Create two private files: encrypted vault and separate encryption secret."],
  ["vault verify", "", "vault", "expected-did", false, "Unlock/verify both keys offline; optionally assert DID or unbound."],
  ["vault backup", "", "vault output", "", false, "Verify both keys and save an exact independent private copy."],
  ["vault import", "", "file vault expected-did", "", false, "Verify/import an exact private backup with reviewed DID or unbound."],
  ["binding show", "", "", "", true, "Read binding expiry and renewal reminder metadata."],
  ["binding renew", "", "expires-at output", "vault", true, "Deliberately renew using owner identity or explicit managed custody."],
  ["profile show", "", "", "", true, "Read the current signed Sender Profile."],
  ["profile create", "", "file", "", true, "Publish the first Sender Profile from an explicit JSON definition."],
  ["profile update", "", "file", "", true, "Publish a new Sender Profile revision from an explicit JSON definition."],
  ["credential list", "", "", "after pages", true, "List account-local credential metadata, never tokens/hashes."],
  ["credential create", "", "output", "scope", true, "Issue inherited or explicitly narrower scopes; retain exact output for retry."],
  ["credential rotate", "", "output", "", true, "Verify replacement before revoking source; retain output and rotation sidecar."],
  ["credential revoke", "<credential-id>", "", "", true, "Revoke one selected account-local credential."],
  ["send", "", "grant file state", "category reply-until", true, "Send bounded text with one stable saved ID; generic received is indeterminate."],
  ["reply", "<original-message-id>", "file state", "reply-until", true, "Use an original signed reply invitation, not untrusted message instructions."],
  ["inbox list", "", "", "after pages", true, "List delivered recipient messages with resumable bounded pagination."],
  ["inbox show", "<sender-did> <message-id>", "", "", true, "Read one sender-scoped message; body content is untrusted data."],
  ["message status", "<message-id>", "", "wait interval", true, "Read/poll retained status; indeterminate never promises acceptance."],
  ["message submit", "<message-id>", "", "", true, "Resubmit the exact stored envelope under the same message ID."],
  ["grant list", "", "", "after pages", true, "List scoped Grant roles and revisions."],
  ["grant create", "<sender-address>", "output", "category uncategorized vault expires-at no-expiry", true, "Select categories or uncategorized; owner signing unlocks identity only."],
  ["grant update", "<grant-id>", "output", "category uncategorized vault expires-at no-expiry refresh-consent sender", true, "Sign a full-state revision; expanded permission requires fresh verified consent."],
  ["grant show", "<grant-id>", "", "output", true, "Read diagnostic Grant JSON; optional output retains exact signed COSE bytes."],
  ["grant submit", "<private-signed-grant.cose>", "", "", true, "Submit retained signed bytes; durable publication is not peer acknowledgement."],
  ["grant revoke", "<grant-id>", "", "vault output", true, "Sign a terminal revision; owner-controlled custody requires vault and output."],
] as const;
type Command = typeof commands[number];
const words = (text: string) => text ? text.split(" ") : [];
const selection = ["credentials", "provider", "account-id"];

function help(command?: Command, prefix = ""): string {
  const entries = command ? [command] : commands.filter(entry => entry[0].startsWith(prefix));
  return `hailp — Hail Protocol account CLI\n\n${entries.map(entry => {
    const [name, args, required, optional, authenticated, description] = entry;
    const flags = [...words(required).map(flag => `--${flag}${options[flag as keyof typeof options].type === "string" ? " <value>" : ""}`),
      ...words(optional).map(flag => `[--${flag}${options[flag as keyof typeof options].type === "string" ? " <value>" : ""}]`)];
    return `  hailp ${name}${args ? ` ${args}` : ""}${flags.length ? ` ${flags.join(" ")}` : ""}\n    ${description}${authenticated ? "\n    Selection: --credentials <private-file> or HAILP_CREDENTIAL_FILE; optional --provider <https-origin> and --account-id <uuid> assertions." : ""}`;
  }).join("\n\n")}\n\nResults: JSON stdout; errors/prompts: stderr. --help/-h and --version are offline.\nRepeatable options: --category and --scope. Secret input: hidden terminal or protected stdin.\nWait: --wait 1–300 seconds, --interval 1–30 (default 2). Lists: --pages 1–100 (default 1).`;
}

export function boundedInteger(value: string | undefined, name: string, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) throw new CliError("USAGE_ERROR", `--${name} must be an integer from 1 to ${max}`);
  return Number(value);
}

export function parseCommand(args: string[]) {
  let parsed;
  try { parsed = parseArgs({ args, options, allowPositionals: true, tokens: true }); }
  catch { throw new CliError("USAGE_ERROR", "Unknown option or missing/invalid option value; use hailp --help"); }
  const { values, positionals, tokens } = parsed;
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === "option") {
    if (seen.has(token.name) && token.name !== "category" && token.name !== "scope") throw new CliError("USAGE_ERROR", `Repeated --${token.name} is not allowed`);
    seen.add(token.name);
  }
  if (values.version) {
    if (positionals.length || Object.keys(values).length !== 1) throw new CliError("USAGE_ERROR", "Use hailp --version alone");
    return { values, positionals, authenticated: false, version: true, help: undefined };
  }
  const command = commands.find(entry => words(entry[0]).every((word, index) => positionals[index] === word));
  if (!command) {
    const prefix = positionals.join(" ");
    if ((!positionals.length || values.help && commands.some(entry => entry[0].startsWith(`${prefix} `))) &&
      Object.keys(values).every(key => key === "help")) return { values, positionals, authenticated: false, version: false, help: help(undefined, prefix) };
    throw new CliError("USAGE_ERROR", "Unknown command; use hailp --help");
  }
  const [name, argumentsText, required, optional, authenticated] = command;
  const count = words(name).length + words(argumentsText).length;
  const allowed = [...words(required), ...words(optional), ...(authenticated ? selection : []), "help"];
  if (Object.keys(values).some(key => !allowed.includes(key)) || positionals.length > count || !values.help && positionals.length !== count) {
    throw new CliError("USAGE_ERROR", `Invalid arguments/options for ${name}; use hailp ${name} --help`);
  }
  if (values.help) return { values, positionals, authenticated, version: false, help: help(command) };
  if (words(required).some(key => !values[key as keyof typeof values])) throw new CliError("USAGE_ERROR", `Missing required options; use hailp ${name} --help`);
  if (values["expires-at"] !== undefined && values["no-expiry"] || values.category && values.uncategorized ||
    name.startsWith("grant ") && ["grant create", "grant update"].includes(name) && !values.category && !values.uncategorized) {
    throw new CliError("USAGE_ERROR", "Select categories or --uncategorized, and only one expiry option");
  }
  if (values.category?.some(value => !value) || values.scope?.some(value => !value)) throw new CliError("USAGE_ERROR", "Categories/scopes must not be empty");
  if (name === "send" && values.category && values.category.length !== 1) throw new CliError("USAGE_ERROR", "Messages select exactly one category");
  if (name === "account create" && !["owner-controlled", "managed"].includes(values.custody!)) throw new CliError("USAGE_ERROR", "Select owner-controlled or managed custody");
  if (name === "account create" && Boolean(values["monitor-origin"]) !== Boolean(values["monitor-key"])) throw new CliError("USAGE_ERROR", "Use --monitor-origin and --monitor-key together");
  if (name === "account create" && values["monitor-attestation"] && !values["monitor-key"]) throw new CliError("USAGE_ERROR", "Monitor attestation requires monitor origin/key");
  if (name === "account login" && !["identity", "owner-recovery"].includes(values.signer!)) throw new CliError("USAGE_ERROR", "Select identity or owner-recovery signer");
  for (const key of ["expires-at", "reply-until"] as const) if (values[key] !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])))) throw new CliError("USAGE_ERROR", `--${key} must be a safe Unix timestamp`);
  if (values["reply-until"] !== undefined && Number(values["reply-until"]) <= Math.floor(Date.now() / 1000) ||
    name === "grant create" && values["expires-at"] !== undefined && Number(values["expires-at"]) <= Math.floor(Date.now() / 1000)) {
    throw new CliError("USAGE_ERROR", "Creation/reply deadlines must be in the future");
  }
  boundedInteger(values.pages, "pages", 100, 1);
  boundedInteger(values.wait, "wait", 300, 1);
  boundedInteger(values.interval, "interval", 30, 2);
  if (values.interval && !values.wait) throw new CliError("USAGE_ERROR", "--interval requires --wait");
  return { values, positionals, authenticated, version: false, help: undefined };
}
