import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import { BodyRepository } from "../bodies/repository.js";
import { checkAuthorization, newBodyToken } from "../bodies/service.js";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";

const [senderDid, recipientDid, messageId, digestText, availableText] = Bun.argv.slice(2);
if (!senderDid || !recipientDid || !messageId || !digestText || !availableText) {
  throw new Error("Usage: bun run body:authorize -- <sender-did> <recipient-did> <message-uuidv7> <digest-base64url> <available-until-unix-seconds>");
}
const digest = decodeBase64Url(digestText);
if (encodeBase64Url(digest) !== digestText) throw new Error("Noncanonical digest");
const availableUntil = Number(availableText);
const token = newBodyToken();
const input = { senderDid, recipientDid, messageId, digest, token, availableUntil, expiresAt: availableUntil };
checkAuthorization(input);
const database = new ProviderDatabase(loadConfig().databaseUrl);
try {
  await database.migrate();
  await new BodyRepository(database.sql).authorize(input);
  // The raw token is returned only once. Store it with the signed envelope; never log it in the server.
  console.info(JSON.stringify({ token: encodeBase64Url(token), expiresAt: availableUntil }, null, 2));
} finally {
  await database.close();
}
