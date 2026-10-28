// Rendering is deliberately independent of delivery, signature verification and retries.
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "Unknown";
const descriptions: Record<string, [string, string]> = {
  rotationKeys: ["Identity control and recovery keys changed", "The keys or their priority for identity updates and recovery changed."],
  alsoKnownAs: ["Identity aliases changed", "The aliases listed in the identity document changed. This alone does not prove a Hail address binding changed."],
  "verificationMethods.hail-identity": ["Identity signing key changed", "The key used to verify your Hail identity changed."],
  "verificationMethods.hail-messaging": ["Messaging key changed", "The key used to verify Hail messaging signatures changed."],
  "services.hail": ["Messaging service changed", "The identity's messaging service configuration changed; clients may use a different messaging endpoint."],
};

export function alertMessage(alert: Record<string, unknown>, hailAddress?: string): { subject: string; text: string } {
  const detail = record(alert.detail);
  // A stored, server-supplied account label, never the notification mailbox or an observed alias.
  const address = hailAddress && hailAddress.length <= 254 && !/[\s\x00-\x1f\x7f]/.test(hailAddress) ? hailAddress : undefined;
  const identity = address ?? String(alert.did);
  const changes = Array.isArray(detail.changes) ? detail.changes.map(record) : [];
  const labels = changes.map(change => descriptions[String(change.field)]?.[0] ?? `Identity field changed: ${String(change.field)}`);
  let title: string, happened: string, impact: string, action: string;
  const status = detail.status === "current" ? "Currently effective" : detail.status === "nullified" ? "Nullified by recovery; no longer effective" :
    detail.status === "superseded" ? "Superseded by a later operation; no longer the current operation" : "Unknown; this older alert has no operation status";
  switch (alert.category) {
    case "onboarding-enrollment":
      title = "Identity monitoring enrolled";
      happened = "Your identity has been enrolled in Hail's PLC monitor.";
      impact = "The monitor saved your initial identity configuration to check future changes against. This does not confirm that all signup steps are complete.";
      action = "No action is needed for this notification if you started this signup. If you did not, investigate the unexpected enrollment.";
      break;
    case "unexpected-operation":
    case "operation-status": {
      const followup = alert.category === "operation-status";
      title = followup ? `Identity change ${detail.status === "nullified" ? "nullified by recovery" : detail.status === "superseded" ? "superseded" : "status updated"}` :
        `Review required: ${changes.length === 1 && descriptions[String(changes[0]?.field)] ? descriptions[String(changes[0]?.field)]![0].toLowerCase() : "identity operation detected"}`;
      happened = followup ? "A previously observed identity operation has changed status." : "The monitor detected an identity operation outside its approved baseline. This alone does not establish that it was malicious.";
      impact = `Status at detection: ${status}.\n` + (changes.length ? changes.map((change, index) =>
        `${labels[index]}: ${descriptions[String(change.field)]?.[1] ?? "Review the old and new values below."}\n  Before: ${JSON.stringify(change.before)}\n  After: ${JSON.stringify(change.after)}`).join("\n") :
        detail.comparisonAvailable === true ? "No identity configuration fields changed relative to this operation's parent." : "The alert does not contain a field comparison; its impact cannot be determined from this notification alone.");
      impact += "\nHistorical changes describe that operation, not necessarily today's configuration. The monitor has not approved or reversed it. Supersession or recovery alone does not establish that the current state is safe.";
      action = "If you initiated a provider move or key change, compare these details with that action. Otherwise, investigate immediately. For an unwanted operation, recovery is time-sensitive; do not wait for another alert. Never share your recovery secret.";
      if (!followup && detail.status === "current") {
        const recorded = typeof detail.operationRecordedAt === "string" ? Date.parse(detail.operationRecordedAt) : NaN;
        action += Number.isFinite(recorded)
          ? ` The 72-hour PLC recovery-window boundary for this operation is ${new Date(recorded + 72 * 3600_000).toISOString()}. It may already have passed; recovery eligibility also depends on the available keys and operation history. Email delivery does not extend this window.`
          : " PLC recovery has a 72-hour window from the unwanted operation, not from this email; the operation time is unavailable here.";
      }
      break;
    }
    case "monitoring-restored":
      title = "Identity monitoring resumed";
      happened = "The monitor successfully validated your identity's operation history again.";
      impact = `Monitoring has resumed; the earlier coverage gap remains part of the record. ${detail.matchesApprovedState === true ? "The current identity matches the approved baseline." : "The current identity does not match the approved baseline and still requires review."}`;
      action = "Review any identity-change alerts from this period. Restored monitoring does not reverse changes or approve them.";
      break;
    case "coverage-lost":
      title = "Identity monitoring coverage interrupted";
      happened = "More than 24 hours elapsed without a successful identity check.";
      impact = "Identity changes may have gone undetected during this gap. This alert does not establish that a change occurred.";
      action = "Check the monitor's availability and review identity history for the gap. A separate notification will report when validation resumes.";
      break;
    case "invalid-operation-log":
      title = "Identity history could not be verified";
      happened = "The monitor could not validate the identity's operation history.";
      impact = "The current identity state cannot be confirmed by this check. This can reflect inconsistent history or a validation failure; it does not prove an account takeover.";
      action = "Investigate the directory history and monitor diagnostics promptly. Wait for a successful validation before relying on monitoring coverage.";
      break;
    default:
      title = "Identity monitoring history gap";
      happened = "The monitor reported a gap in its operation feed.";
      impact = "Monitoring coverage is incomplete. This alert does not establish that your identity changed.";
      action = "Investigate the monitor and directory feed and review the missing period.";
  }
  const times = [`Detected: ${timestamp(detail.observedAt ?? alert.occurred_at)}`];
  if (detail.operationRecordedAt) times.unshift(`Operation recorded by directory: ${timestamp(detail.operationRecordedAt)}`);
  if (detail.enrolledAt) times.push(`Enrolled: ${timestamp(detail.enrolledAt)}`);
  if (detail.lastHealthyAt) times.push(`Last successful check: ${timestamp(detail.lastHealthyAt)}`);
  return { subject: `[Hail PLC] ${title}: ${identity}`,
    text: `${happened}\n\nHail address: ${address ?? "Not available (not retained during enrollment)"}\nDID: ${alert.did}\n\nWhat this means\n${impact}\n\nWhat to do\n${action}\n\n${times.join("\n")}\n\nTechnical details (signed monitor payload)\n${JSON.stringify(alert, null, 2)}` };
}
