import {expect, it} from "vitest";
import {brandingFromEnvironment} from "./branding.js";

it("defaults to protocol-neutral branding and permits deployment-specific assets", () => {
  expect(brandingFromEnvironment({})).toEqual({name:"Hail", logoPath:null, faviconPath:"/favicon.svg"});
  expect(brandingFromEnvironment({HAIL_WEB_CLIENT_NAME:"Example Mail", HAIL_WEB_CLIENT_LOGO_PATH:"/brand/logo.svg",
    HAIL_WEB_CLIENT_FAVICON_PATH:"/brand/favicon.png", SIGNUP_MONITOR_TOKEN:"secret"}))
    .toEqual({name:"Example Mail", logoPath:"/brand/logo.svg", faviconPath:"/brand/favicon.png"});
});

it("keeps branding assets within the same-origin CSP", () => {
  for (const value of ["https://tracking.example/logo.svg", "//tracking.example/logo.svg", "/../secret", "javascript:alert(1)", "/\\evil"])
    expect(() => brandingFromEnvironment({HAIL_WEB_CLIENT_LOGO_PATH:value})).toThrow("same-origin");
});
