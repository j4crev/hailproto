import {expect, it, vi, afterEach} from "vitest";
import {avatarDefinition, prepareAvatar} from "./avatar.js";
import type {ProfileDefinition} from "./sender-profile.js";

afterEach(() => vi.unstubAllGlobals());
const base: ProfileDefinition = {version: 1, display_name: "Alice", description: "About", offers_uncategorized: true,
  categories: [{id: "general", label: "General"}, {id: "news", label: "News", description: "Updates"}]};
it("upgrades legacy profiles and replaces/removes only the avatar", () => {
  expect(avatarDefinition(base, "AQID")).toEqual({...base, version: 2, avatar: "AQID"});
  expect(avatarDefinition({...base, version: 2, avatar: "old"}, null)).toEqual({...base, version: 2});
  expect(base.version).toBe(1);
  expect(avatarDefinition({...base, categories: []}, "AQID").categories).toEqual([{id: "general", label: "General"}]);
});
it("rejects unsupported, empty and oversized files before decoding", async () => {
  for (const file of [new File(["svg"], "avatar.svg", {type: "image/svg+xml"}), new File([], "empty.png", {type: "image/png"}),
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.jpg", {type: "image/jpeg"})]) {
    await expect(prepareAvatar(file)).rejects.toThrow();
  }
});
it("center crops, reduces dimensions to the byte limit and releases the original URL", async () => {
  const drawImage = vi.fn(), revokeObjectURL = vi.fn();
  const canvas = {width: 0, height: 0, getContext: () => ({drawImage}),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(canvas.width > 128 ? 40_000 : 20_000)]))};
  vi.stubGlobal("URL", {createObjectURL: () => "blob:photo", revokeObjectURL});
  vi.stubGlobal("Image", class {naturalWidth = 800; naturalHeight = 600; decode = async () => {};});
  vi.stubGlobal("document", {createElement: () => canvas});
  const result = await prepareAvatar(new File(["photo"], "photo.jpg", {type: "image/jpeg"}));
  expect(Buffer.from(result, "base64url")).toHaveLength(20_000);
  expect(drawImage).toHaveBeenLastCalledWith(expect.anything(), 100, 0, 600, 600, 0, 0, 128, 128);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:photo");
});
it("releases the original URL when decoding fails", async () => {
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", {createObjectURL: () => "blob:broken", revokeObjectURL});
  vi.stubGlobal("Image", class {decode = async () => {throw new Error("Invalid image");};});
  await expect(prepareAvatar(new File(["bad"], "bad.png", {type: "image/png"}))).rejects.toThrow("Couldn’t read");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:broken");
});
