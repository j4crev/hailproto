import { encodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { EnvelopeRepository } from "../envelopes/repository.js";
import { EnvelopeService } from "../envelopes/service.js";
import { GrantRepository } from "../grants/repository.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const [sender, replyTo, digest, flag, untilText] = Bun.argv.slice(2);
if (!sender || !replyTo || !digest ||
  (flag !== undefined && (flag !== "--reply-until" || untilText === undefined)) ||
  (flag === undefined && untilText !== undefined) || Bun.argv.length > 7) {
  throw new Error("Usage: bun run envelope:reply -- <sender-did> <original-message-id> <body-digest> [--reply-until <unix-seconds>]");
}
const replyUntil = untilText === undefined ? null : Number(untilText);
if (replyUntil !== null && !Number.isSafeInteger(replyUntil)) throw new Error("Invalid reply-until timestamp");
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const result = await new EnvelopeService(
    new OnboardingRepository(database.sql), new GrantRepository(database.sql),
    new EnvelopeRepository(database.sql), new KeyEncryptor(config.keyEncryptionKey),
    createHailDidResolver(config,database.sql), config.hailServiceBase,
  ).createReply(sender, replyTo, digest, replyUntil);
  console.info(JSON.stringify({ messageId: result.payload.message_id,
    replyTo, envelopeDigest: encodeBase64Url(result.digest), destination: result.destination,
    state: "signed-and-persisted" }, null, 2));
} finally { await database.close(); }
