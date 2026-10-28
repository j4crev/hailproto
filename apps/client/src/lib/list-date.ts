/** Compare local calendar days, including across daylight-saving changes. */
export function listDate(value: string | number | Date, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const age = (day(now) - day(date)) / 86_400_000;
  if (age === 0) return date.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
  if (age === 1) return "Yesterday";
  if (age > 1 && age < 7) return date.toLocaleDateString("en-US", {weekday: "long"});
  return date.toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? {year: "numeric"} : {}),
  });
}
