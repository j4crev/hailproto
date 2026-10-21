interface ParsedMediaType {
  type: string;
  subtype: string;
  parameters: Map<string, string>;
}

function parse(value: string): ParsedMediaType | null {
  const parts = value.split(";");
  const essence = parts.shift()?.trim().toLowerCase();
  const separator = essence?.indexOf("/") ?? -1;
  if (!essence || separator < 1 || separator === essence.length - 1) return null;
  const parameters = new Map<string, string>();
  for (const raw of parts) {
    const equals = raw.indexOf("=");
    if (equals < 1) return null;
    const name = raw.slice(0, equals).trim().toLowerCase();
    let parameter = raw.slice(equals + 1).trim();
    if (!/^[a-z0-9!#$&^_.+-]+$/.test(name) || parameters.has(name)) return null;
    if (parameter.startsWith('"') || parameter.endsWith('"')) {
      if (!/^"[^"\\]*"$/.test(parameter)) return null;
      parameter = parameter.slice(1, -1);
    }
    if (!parameter) return null;
    parameters.set(name, parameter.toLowerCase());
  }
  return {
    type: essence.slice(0, separator),
    subtype: essence.slice(separator + 1),
    parameters,
  };
}

export function isCoseSign1MediaType(value: string | null): boolean {
  if (value === null) return false;
  const parsed = parse(value);
  return (
    parsed?.type === "application" &&
    parsed.subtype === "cose" &&
    parsed.parameters.size === 1 &&
    parsed.parameters.get("cose-type") === "cose-sign1"
  );
}

function quality(value: string | undefined): number | null {
  if (value === undefined) return 1;
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return null;
  return Number(value);
}

export function acceptsCoseSign1(value: string | undefined): boolean {
  if (value === undefined) return true;
  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const item of value.split(",")) {
    const parsed = parse(item);
    if (!parsed) continue;
    const q = quality(parsed.parameters.get("q"));
    if (q === null) continue;
    parsed.parameters.delete("q");
    const typeMatches = parsed.type === "*" || parsed.type === "application";
    const subtypeMatches = parsed.subtype === "*" || parsed.subtype === "cose";
    if (!typeMatches || !subtypeMatches) continue;
    const coseType = parsed.parameters.get("cose-type");
    if (
      parsed.parameters.size > (coseType === undefined ? 0 : 1) ||
      (coseType !== undefined && coseType !== "cose-sign1")
    ) {
      continue;
    }
    const specificity =
      (parsed.type === "*" ? 0 : parsed.subtype === "*" ? 1 : 2) +
      (coseType === undefined ? 0 : 1);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = q;
    } else if (specificity === bestSpecificity) {
      bestQuality = Math.max(bestQuality, q);
    }
  }
  return bestSpecificity >= 0 && bestQuality > 0;
}
