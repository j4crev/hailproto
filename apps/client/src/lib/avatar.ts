import {encodeBase64Url} from "@hailproto/codec/base64url";
import {GENERAL_CATEGORY, type ProfileDefinition} from "./sender-profile.js";

export function avatarDefinition(base: ProfileDefinition, avatar: string | null): ProfileDefinition {
  const {avatar: _previous, ...rest} = base;
  return {...rest, version: 2,
    categories: base.categories.some(category => category.id === "general") ? base.categories : [...base.categories, {...GENERAL_CATEGORY}],
    ...(avatar ? {avatar} : {})};
}

export function avatarSource(avatar: string | null | undefined): string | null {
  return avatar ? `data:image/png;base64,${avatar.replace(/-/g, "+").replace(/_/g, "/")}` : null;
}

/** Decode and re-encode locally: originals and their metadata never leave the browser. */
export async function prepareAvatar(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPEG, PNG, or WebP photo.");
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error("Choose a photo smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {await image.decode();} catch {throw new Error("Couldn’t read this photo. Try another JPEG, PNG, or WebP image.");}
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 50_000_000) {
      throw new Error("Choose a photo with fewer than 50 megapixels.");
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser couldn’t prepare the photo. Try another browser.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    // PNG is lossless; reduce dimensions until even detailed photos fit the protocol limit.
    for (const size of [256, 192, 128, 96, 64]) {
      canvas.width = canvas.height = Math.min(size, side);
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      if (blob && blob.size <= 32_768) return encodeBase64Url(new Uint8Array(await blob.arrayBuffer()));
    }
    throw new Error("Couldn’t resize this photo. Try another image.");
  } finally {URL.revokeObjectURL(url);}
}
