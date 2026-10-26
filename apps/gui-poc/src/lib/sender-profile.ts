import type {HailSenderProfile} from "@hailproto/codec";
import {encodeBase64Url} from "@hailproto/codec/base64url";

export type Category = {id: string; label: string; description?: string};
export const GENERAL_CATEGORY: Readonly<Category> = Object.freeze({id: "general", label: "General"});
export type ProfileDefinition = {version: 1 | 2; display_name: string; description?: string; offers_uncategorized: boolean; categories: Category[]; avatar?: string};

export function editableProfile(profile: HailSenderProfile): ProfileDefinition {
  return {version: profile.version, display_name: profile.display_name,
    ...(profile.description === undefined ? {} : {description: profile.description}),
    offers_uncategorized: profile.offers_uncategorized,
    categories: profile.categories.map(category => ({...category})),
    ...(profile.version === 2 && profile.assets ? {avatar: encodeBase64Url(profile.assets.assets[0]!.data)} : {})};
}

export function profileDraft(base: ProfileDefinition, name: string, description: string, categories: Category[]): ProfileDefinition {
  const text = (value: string, max: number, label: string, required = false) => {
    const normalized = value.trim().normalize("NFC");
    if (required && !normalized || new TextEncoder().encode(normalized).length > max || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error(`Check ${label}.`);
    return normalized;
  };
  const display_name = text(name, 128, "your sender name", true);
  const about = text(description, 1024, "your description");
  if (categories.filter(category => category.id.trim() !== "general").length > 99) throw new Error("Use at most 99 custom categories plus General.");
  const ids = new Set<string>();
  const cleaned = categories.map(category => {
    const id = category.id.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || ids.has(id)) throw new Error("Give each category a unique ID using lowercase letters, numbers, dots, hyphens or underscores.");
    ids.add(id);
    if (id === "general") return {...GENERAL_CATEGORY};
    const label = text(category.label, 128, "the category name", true);
    const detail = text(category.description ?? "", 1024, "the category description");
    return {id, label, ...(detail ? {description: detail} : {})};
  });
  if (!ids.has("general")) cleaned.push({...GENERAL_CATEGORY});
  cleaned.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const {description: _old, ...rest} = base;
  return {...rest, display_name, ...(about ? {description: about} : {}), categories: cleaned};
}
