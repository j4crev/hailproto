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
