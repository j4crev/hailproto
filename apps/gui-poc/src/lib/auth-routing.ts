// Only inbox screens are valid post-login destinations, never auth or external URLs.
export function isAccountPath(path: string): boolean {
  return /^\/(?:compose|permissions|sent(?:\/[^/]+)?|message\/[^/]+\/[^/]+|settings\/security)\/?$/.test(path);
}

export function returnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/";
  const url = new URL(value, "https://hail.invalid");
  return url.origin === "https://hail.invalid" && (url.pathname === "/" || isAccountPath(url.pathname))
    ? url.pathname + url.search + url.hash : "/";
}

export function loginPath(url?: URL): string {
  return "/auth/login?next=" + encodeURIComponent(returnPath(url ? url.pathname + url.search : "/"));
}
