package hailcodec

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func assetFixture(t *testing.T) *AssetManifest {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return &AssetManifest{Version: 1, Assets: []BundledImageAsset{{
		ID: "hero-image", Role: "header", MediaType: "image/png", Loading: "bundled",
		Size: int64(len(data)), Digest: Digest{Algorithm: "sha-256", Value: digest[:]},
		Width: 1, Height: 1, Data: data,
	}}}
}

func TestAssetManifest(t *testing.T) {
	manifest := assetFixture(t)
	if err := ValidateAssetManifest(manifest); err != nil {
		t.Fatalf("rejected valid asset manifest: %v", err)
	}
	manifest.Assets[0].Digest.Value[0] ^= 1
	if err := ValidateAssetManifest(manifest); err == nil {
		t.Fatal("accepted mismatched asset digest")
	}
	manifest = assetFixture(t)
	manifest.Assets[0].Data[29] ^= 1
	digest := sha256.Sum256(manifest.Assets[0].Data)
	manifest.Assets[0].Digest.Value = digest[:]
	if err := ValidateAssetManifest(manifest); err == nil {
		t.Fatal("accepted invalid PNG chunk CRC")
	}
}
