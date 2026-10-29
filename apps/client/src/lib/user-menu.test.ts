import {expect, it, vi} from "vitest";
import {render} from "svelte/server";
vi.mock("$app/navigation", () => ({afterNavigate: () => {}}));
import UserMenu from "./UserMenu.svelte";

it("renders the saved photo in desktop and compact mobile menus", () => {
  for (const compact of [false, true]) {
    const {body} = render(UserMenu, {props: {address: "alice@example.com", compact, avatar: "data:image/png;base64,AQID"}});
    expect(body).toContain('src="data:image/png;base64,AQID"');
    expect(body).toContain('aria-label="Open account menu"');
    expect(body).toContain('href="/account"');
    expect(body).not.toContain('/settings/security');
    expect(body).not.toContain('>AL<');
  }
});
it("retains initials when the photo is removed or missing", () => {
  const {body} = render(UserMenu, {props: {address: "alice@example.com", avatar: null}});
  expect(body).toContain('AL');
  expect(body).not.toContain('<img');
});
