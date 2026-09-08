import {
  decodeDeterministic,
  encodeDeterministic,
  type HailResourceLimits,
} from "./cbor.js";
import type { HailPayloadType } from "./types.js";
import type { HailPayloadByType } from "./models.js";
import { validatePayload } from "./validation.js";

export function encodePayload<T extends HailPayloadType>(
  type: T,
  payload: HailPayloadByType[T],
  limits?: HailResourceLimits,
): Uint8Array {
  validatePayload(type, payload);
  return encodeDeterministic(payload, limits);
}

export function decodePayload<T extends HailPayloadType>(
  type: T,
  bytes: Uint8Array,
  limits?: HailResourceLimits,
): HailPayloadByType[T] {
  const payload: unknown = decodeDeterministic(bytes, limits);
  validatePayload(type, payload);
  return payload;
}
