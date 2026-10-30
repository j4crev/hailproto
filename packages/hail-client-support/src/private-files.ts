import { open, readFile, stat, unlink } from "node:fs/promises";

export async function privateFile(path: string, limit: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > limit || (info.mode & 0o077) !== 0) {
    throw new Error("Client files must be bounded private mode-0600 regular files");
  }
  return new Uint8Array(await readFile(path));
}

export async function savePrivateBytes(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(bytes); await file.sync(); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(path); }
}
