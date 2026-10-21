import { createHash } from "node:crypto";
import { decodeBase64Url, encodeBase64Url, inspectSignedPayload } from "@hailproto/codec";
import { privateFile, signGrantRevocation } from "../grant-revocation.js";
import { readRecoverySecret } from "./private-input.js";

const [vaultPath, grantPath, grantId, senderAddress, outputPath] = Bun.argv.slice(2);
if (!vaultPath || !grantPath || !grantId || !senderAddress || !outputPath || Bun.argv.length !== 7) {
  throw new Error("Usage: bun run poc:revoke-grant -- <private-vault> <current-signed-grant.cose> <reviewed-grant-id> <reviewed-sender-address> <new-signed-revocation.cose>");
}
const secret = decodeBase64Url(await readRecoverySecret());
try {
  const representation = await signGrantRevocation(vaultPath, await privateFile(grantPath, 262_144),
    grantId, senderAddress, outputPath, secret);
  const payload = inspectSignedPayload("hail.grant", representation).payload;
  console.info(JSON.stringify({ grantId, revision: payload.revision, state: "signed-revocation",
    reviewedSenderAddress: senderAddress,
    digest: encodeBase64Url(createHash("sha256").update(representation).digest()), signedFile: outputPath }));
} finally { secret.fill(0); }
