/** Provider-local browser session durations, in seconds. */
export interface SessionPolicy {
  idleSeconds: number;
  absoluteSeconds: number;
}

export const DEFAULT_SESSION_POLICY: Readonly<SessionPolicy> = Object.freeze({
  idleSeconds: 1800,
  absoluteSeconds: 43200,
});

export function sessionPolicy(environment: Record<string, string | undefined>): SessionPolicy {
  function seconds(name: string, fallback: number): number {
    const text = environment[name]?.trim();
    if (text === undefined) return fallback;
    const value = Number(text);
    // Bound cookie lifetimes and timestamp arithmetic; zero never disables expiry.
    if (!Number.isSafeInteger(value) || value < 1 || value > 31_536_000 || String(value) !== text)
      throw new Error(`${name} must be a canonical integer from 1 through 31536000 seconds`);
    return value;
  }
  const idleSeconds = seconds("PASSKEY_SESSION_IDLE_SECONDS", DEFAULT_SESSION_POLICY.idleSeconds);
  const absoluteSeconds = seconds("PASSKEY_SESSION_ABSOLUTE_SECONDS", DEFAULT_SESSION_POLICY.absoluteSeconds);
  if (idleSeconds > absoluteSeconds)
    throw new Error("PASSKEY_SESSION_IDLE_SECONDS must not exceed PASSKEY_SESSION_ABSOLUTE_SECONDS");
  return {idleSeconds, absoluteSeconds};
}
