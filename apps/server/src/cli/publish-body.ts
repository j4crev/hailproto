import { encodeBase64Url } from "@hailproto/codec";
import { BodyRepository } from "../bodies/repository.js";
import { bodyFromText } from "../bodies/service.js";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";

const did = Bun.argv[2];
const file = Bun.argv[3];
if (!did || !file) throw new Error("Usage: bun run body:publish -- <sender-did> <utf8-text-file>");
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const text = await Bun.file(file).text();
  const body = await new BodyRepository(database.sql).publish(did, bodyFromText(text));
  console.info(JSON.stringify({ digest: encodeBase64Url(body.digest), size: body.bytes.length,
    mediaType: "application/hail-body+cbor", profile: "spt-1",
    url: `${config.hailServiceBase}/bodies/${encodeBase64Url(body.digest)}` }, null, 2));
} finally {
  await database.close();
}
