import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HailCodecError, validateAssetManifest, type HailAssetManifest } from "../src/index.js";

const png = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function manifest(): HailAssetManifest {
  return { version: 1, assets: [{
    id: "hero-image",
    role: "header",
    media_type: "image/png",
    loading: "bundled",
    size: png.length,
    digest: { algorithm: "sha-256", value: new Uint8Array(createHash("sha256").update(png).digest()) },
    width: 1,
    height: 1,
    data: png,
  }] };
}

function replaceData(value:HailAssetManifest,data:Uint8Array){value.assets[0]!.data=data;value.assets[0]!.size=data.length;
  value.assets[0]!.digest.value=new Uint8Array(createHash("sha256").update(data).digest());}

describe("asset manifest", () => {
  it("accepts a bounded digest-bound PNG", () => {
    expect(() => validateAssetManifest(manifest())).not.toThrow();
  });

  it("rejects bytes that do not match the manifest", () => {
    const invalid = manifest();
    invalid.assets[0].digest.value[0]! ^= 1;
    expect(() => validateAssetManifest(invalid)).toThrow(HailCodecError);
  });

  it("rejects invalid PNG structure even when its digest and dimensions match",()=>{
    const invalid=manifest(),data=Uint8Array.from(invalid.assets[0]!.data);data[29]=data[29]!^1;replaceData(invalid,data);
    expect(()=>validateAssetManifest(invalid)).toThrow(/CRC/);
  });
});
