import {writable} from "svelte/store";
export const HEADER_PREFERENCE = "hail.gui.showInboxHeaders";
// Shared for client-side navigation, including when browser storage is blocked.
export const showInboxHeaders = writable(true);
export function loadHeaderPreference() {
  try { showInboxHeaders.set(localStorage.getItem(HEADER_PREFERENCE) !== "false"); }
  catch { /* Keep the in-memory choice when storage is unavailable. */ }
}
export function saveHeaderPreference(value: boolean): boolean {
  showInboxHeaders.set(value);
  try { localStorage.setItem(HEADER_PREFERENCE, String(value)); return true; }
  catch { return false; }
}

export type ThemePreference = "system" | "light" | "dark";
export const THEME_PREFERENCE = "hail.gui.theme";
export const themePreference = writable<ThemePreference>("system");
function normalizeTheme(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
function applyTheme(value: ThemePreference) {
  document.documentElement.dataset.theme = value;
  themePreference.set(value);
}
// Called once by the root layout, after the pre-paint script has run.
export function initializeThemePreference() {
  applyTheme(normalizeTheme(document.documentElement.dataset.theme));
  const synchronize = (event: StorageEvent) => {
    if (event.key === THEME_PREFERENCE || event.key === null) {
      applyTheme(normalizeTheme(event.newValue));
    }
  };
  window.addEventListener("storage", synchronize);
  return () => window.removeEventListener("storage", synchronize);
}
export function saveThemePreference(value: ThemePreference): boolean {
  applyTheme(value);
  try { localStorage.setItem(THEME_PREFERENCE, value); return true; }
  catch { return false; }
}
