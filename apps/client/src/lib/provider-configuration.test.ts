import {afterEach, expect, it, vi} from "vitest";

const {env} = vi.hoisted(() => ({env:{} as Record<string,string>}));
vi.mock("$env/dynamic/private", () => ({env}));
vi.mock("$app/environment", () => ({building:false}));
afterEach(() => {for (const key of Object.keys(env)) delete env[key]; vi.resetModules();});

it("refuses to silently select a hosted provider when configuration is missing", async () => {
  await expect(import("./server/canary.js")).rejects.toThrow("Set HAIL_WEB_CLIENT_PROVIDER");
});

it("uses the configured provider and separate private transport", async () => {
  Object.assign(env, {HAIL_WEB_CLIENT_PROVIDER:"https://independent.example/", HAIL_WEB_CLIENT_API_ORIGIN:"http://provider:3000"});
  const config = await import("./server/canary.js");
  expect(config.PROVIDER).toBe("https://independent.example");
  expect(config.ORIGIN).toBe("https://independent.example");
  expect(config.API_ORIGIN).toBe("http://provider:3000");
});
