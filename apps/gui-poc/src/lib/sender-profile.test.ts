import {expect, it} from "vitest";
import {editableProfile, profileDraft, type ProfileDefinition} from "./sender-profile.js";
import type {HailSenderProfile} from "@hailproto/codec";

const base: ProfileDefinition = {version: 2, display_name: "Original", description: "Old", offers_uncategorized: true, categories: [], avatar: "AQID"};
it("preserves existing avatar and legacy delivery settings while updating and sorting categories", () => {
  expect(profileDraft(base, " Updated ", "", [{id: "z", label: "Last"}, {id: "general", label: " General ", description: " Updates "}]))
    .toEqual({...base, display_name: "Updated", description: undefined, categories: [{id: "general", label: "General", description: "Updates"}, {id: "z", label: "Last"}]});
  expect(base.description).toBe("Old");
});
it("rejects duplicate IDs, invalid IDs, and UTF-8 byte overflow before requesting a passkey", () => {
  for (const categories of [[{id: "bad id", label: "Bad"}], [{id: "a", label: "A"}, {id: "a", label: "B"}], [{id: "a", label: "é".repeat(65)}]]) {
    expect(() => profileDraft(base, "Valid", "", categories)).toThrow();
  }
  expect(() => profileDraft(base, " ", "", [])).toThrow();
  expect(() => profileDraft(base, "Valid", "a".repeat(1025), [])).toThrow();
});
it("projects an existing signed profile without losing its bundled avatar", () => {
  const payload = {version: 2, display_name: "Sender", description: "About", offers_uncategorized: false, categories: [{id: "general", label: "General"}], assets: {assets: [{data: new Uint8Array([1, 2, 3])}]}} as unknown as HailSenderProfile;
  expect(editableProfile(payload)).toEqual({version: 2, display_name: "Sender", description: "About", offers_uncategorized: false, categories: [{id: "general", label: "General"}], avatar: "AQID"});
});
