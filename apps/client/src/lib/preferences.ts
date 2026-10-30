import {writable} from "svelte/store";
import {mailboxRequest} from "./mailbox.js";
let accountDid: string | null = null;
let revision = 0;
let savingAccount = false;
let synchronization: {did: string; promise: Promise<void>} | null = null;
export const HEADER_PREFERENCE = "hail.gui.showInboxHeaders";
// Shared for client-side navigation, including when browser storage is blocked.
export const showInboxHeaders = writable(true);
export function loadHeaderPreference() {
  if (accountDid) return;
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
    if (accountDid) return;
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

const CACHE_OWNER = "hail.gui.preferencesAccount";
type DisplayPreferences = {theme: ThemePreference; showHeaderImages: boolean};
function applyAccountPreferences(value: DisplayPreferences) {
  saveThemePreference(value.theme);
  saveHeaderPreference(value.showHeaderImages);
  try { localStorage.setItem(CACHE_OWNER, accountDid!); } catch { /* Cache is optional. */ }
}
function validDisplayPreferences(value: unknown): value is DisplayPreferences {
  const p = value as DisplayPreferences | null;
  return !!p && ["system", "light", "dark"].includes(p.theme) && typeof p.showHeaderImages === "boolean";
}
export function clearPreferenceAccount() { accountDid = null; revision++; }
export function syncAccountPreferences(did: string): Promise<void> {
  if (savingAccount && did === accountDid) return Promise.resolve();
  if (synchronization?.did === did) return synchronization.promise;
  const promise = loadAccountPreferences(did).finally(() => {
    if (synchronization?.promise === promise) synchronization = null;
  });
  synchronization = {did, promise};
  return promise;
}
async function loadAccountPreferences(did: string) {
  accountDid = did;
  const current = ++revision;
  let preferences = await mailboxRequest("message-preferences");
  if (current !== revision) return;
  if (preferences.theme === null || preferences.showHeaderImages === null) {
    let theme: ThemePreference = "system", showHeaderImages = true;
    try {
      const owner = localStorage.getItem(CACHE_OWNER);
      if (!owner || owner === did) {
        theme = normalizeTheme(localStorage.getItem(THEME_PREFERENCE));
        showHeaderImages = localStorage.getItem(HEADER_PREFERENCE) !== "false";
      }
    } catch { /* Use defaults when browser storage is blocked. */ }
    preferences = await mailboxRequest("message-preferences", {theme, showHeaderImages, initialize: true});
  }
  if (current !== revision) return;
  if (!validDisplayPreferences(preferences)) throw new Error("Account preferences are unavailable. Refresh and try again.");
  applyAccountPreferences(preferences);
}
export async function saveAccountPreferences(patch: Partial<DisplayPreferences>) {
  const current = ++revision;
  savingAccount = true;
  try {
    const preferences = await mailboxRequest("message-preferences", patch);
    if (current !== revision) throw new Error("Preferences changed while saving. Refresh and try again.");
    if (!validDisplayPreferences(preferences)) throw new Error("The change could not be confirmed. Refresh and try again.");
    applyAccountPreferences(preferences);
  } finally { savingAccount = false; }
}
