import {AsyncLocalStorage} from "node:async_hooks";
import type {bootstrapAccount} from "./canary.js";

type Account = ReturnType<typeof bootstrapAccount>;
const reads = new AsyncLocalStorage<Map<string, Account>>();

// Scope only GET rendering. Never retain authentication across requests or actions.
export function withAccountReads<T>(operation: () => T): T {
  return reads.run(new Map(), operation);
}
export function accountRead(key: string, operation: () => Account): Account {
  const cache = reads.getStore();
  if (!cache) return operation();
  let result = cache.get(key);
  if (!result) { result = operation(); cache.set(key, result); }
  return result;
}
