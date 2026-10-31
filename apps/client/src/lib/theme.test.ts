import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {get} from "svelte/store";
import {initializeThemePreference, saveThemePreference, themePreference, THEME_PREFERENCE} from "./preferences.js";

const bootstrap = readFileSync(new URL("../app.html", import.meta.url), "utf8").match(/<script nonce="%sveltekit.nonce%">([\s\S]*?)<\/script>/)![1];
let dataset: Record<string, string>, values: Map<string, string>, listeners: Map<string, (event: unknown) => void>;
beforeEach(() => {
  dataset = {}; values = new Map(); listeners = new Map();
  vi.stubGlobal("document", {documentElement: {dataset}});
  vi.stubGlobal("localStorage", {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value)});
  vi.stubGlobal("window", {addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name)});
  themePreference.set("system");
});
afterEach(() => vi.unstubAllGlobals());
function boot() { runInNewContext(bootstrap, {document, localStorage}); }

it.each(["light", "dark"] as const)("restores %s before hydration and shares it with settings", theme => {
  values.set(THEME_PREFERENCE, theme);
  boot();
  expect(dataset.theme).toBe(theme);
  initializeThemePreference();
  expect(get(themePreference)).toBe(theme);
});
it.each([null, "system", "invalid"])("defaults %s to the CSS system theme", value => {
  if (value) values.set(THEME_PREFERENCE, value);
  boot(); initializeThemePreference();
  expect(dataset.theme).toBe("system");
});
it("persists an override and switching back to system across reloads", () => {
  for (const theme of ["dark", "light", "system"] as const) {
    expect(saveThemePreference(theme)).toBe(true);
    expect(dataset.theme).toBe(theme);
    delete dataset.theme;
    boot(); initializeThemePreference();
    expect(get(themePreference)).toBe(theme);
  }
});
it("keeps the visit usable when storage is blocked", () => {
  vi.stubGlobal("localStorage", {getItem() {throw new Error("blocked");}, setItem() {throw new Error("blocked");}});
  expect(boot).not.toThrow();
  initializeThemePreference();
  expect(saveThemePreference("dark")).toBe(false);
  expect(dataset.theme).toBe("dark");
  expect(get(themePreference)).toBe("dark");
});
it("synchronizes other tabs, deletion and storage clearing, and removes its listener", () => {
  const cleanup = initializeThemePreference();
  const change = listeners.get("storage")!;
  change({key: THEME_PREFERENCE, newValue: "dark"});
  expect(get(themePreference)).toBe("dark");
  change({key: "unrelated", newValue: "light"});
  expect(get(themePreference)).toBe("dark");
  change({key: THEME_PREFERENCE, newValue: null});
  expect(get(themePreference)).toBe("system");
  change({key: THEME_PREFERENCE, newValue: "light"});
  change({key: null, newValue: null});
  expect(dataset.theme).toBe("system");
  cleanup(); expect(listeners.size).toBe(0);
});

it.each(["light", "dark"])("keeps %s text, alerts and filled controls above 4.5:1 contrast", theme => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const dark = theme === "dark" ? css.match(/:root\[data-theme="dark"\] \{([^}]+)\}/)![1] : css.match(/@theme \{([^}]+)\}/)![1];
  const colors = Object.fromEntries([...dark.matchAll(/--color-([\w-]+): (#[\da-f]{6})/g)].map(match => [match[1], match[2]]));
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map(value => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const pairs = [
    ...["canvas", "surface", "brand-soft"].flatMap(background => ["ink", "muted", "brand", "brand-strong"].map(foreground => [foreground, background])),
    ["danger", "danger-soft"], ["warning", "warning-soft"], ["on-brand", "brand"], ["on-brand", "brand-strong"]
  ];
  for (const [foreground, background] of pairs) {
    const a = luminance(colors[foreground]), b = luminance(colors[background]);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});
