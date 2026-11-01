export interface Branding { name: string; logoPath: string | null; faviconPath: string }
export const defaultBranding: Branding = {name: "Hail", logoPath: null, faviconPath: "/favicon.svg"};

export function brandingFromEnvironment(env: Record<string, string | undefined>): Branding {
  const name = env.HAIL_WEB_CLIENT_NAME?.trim() || defaultBranding.name;
  if (name.length > 80) throw new Error("HAIL_WEB_CLIENT_NAME must be at most 80 characters");
  const asset = (key: string, fallback: string | null) => {
    const value = env[key]?.trim();
    if (!value) return fallback;
    // Keep assets same-origin, consistent with the client's CSP and privacy model.
    if (!/^\/(?!\/)[A-Za-z0-9_./-]+$/.test(value) || value.split("/").includes(".."))
      throw new Error(`${key} must be an absolute same-origin asset path`);
    return value;
  };
  return {name, logoPath: asset("HAIL_WEB_CLIENT_LOGO_PATH", null),
    faviconPath: asset("HAIL_WEB_CLIENT_FAVICON_PATH", defaultBranding.faviconPath)!};
}
