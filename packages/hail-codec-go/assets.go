package hailcodec

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
)

var assetIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func pngDimensions(data []byte) (int64, int64, error) {
	signature := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	if len(data) < 45 || !bytes.Equal(data[:8], signature) {
		return 0, 0, errors.New("asset data must be a PNG image")
	}
	offset, width, height := 8, int64(0), int64(0)
	header, imageData, endChunk := false, false, false
	for offset+12 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := offset + 12 + length
		if length < 0 || end < offset || end > len(data) {
			return 0, 0, errors.New("asset data contains a truncated PNG chunk")
		}
		chunkType := string(data[offset+4 : offset+8])
		if !header && chunkType != "IHDR" {
			return 0, 0, errors.New("asset PNG must begin with IHDR")
		}
		switch chunkType {
		case "IHDR":
			if header || length != 13 {
				return 0, 0, errors.New("asset PNG has invalid IHDR")
			}
			header = true
			width = int64(binary.BigEndian.Uint32(data[offset+8 : offset+12]))
			height = int64(binary.BigEndian.Uint32(data[offset+12 : offset+16]))
		case "acTL":
			return 0, 0, errors.New("animated PNG is unsupported")
		case "IDAT":
			imageData = true
		case "IEND":
			if length != 0 || end != len(data) {
				return 0, 0, errors.New("asset PNG has invalid IEND")
			}
			endChunk = true
		}
		offset = end
		if endChunk {
			break
		}
	}
	if !header || !imageData || !endChunk || width == 0 || height == 0 {
		return 0, 0, errors.New("asset data must be a complete PNG image")
	}
	return width, height, nil
}

func ValidateAssetManifest(manifest *AssetManifest) error {
	if manifest == nil || manifest.Version != 1 || len(manifest.Assets) < 1 || len(manifest.Assets) > 2 {
		return errors.New("invalid asset manifest header or count")
	}
	ids, roles := map[string]bool{}, map[string]bool{}
	for index, asset := range manifest.Assets {
		path := fmt.Sprintf("assets[%d]", index)
		if !assetIDPattern.MatchString(asset.ID) || ids[asset.ID] {
			return fmt.Errorf("%s has invalid or duplicate id", path)
		}
		if asset.Role != "avatar" && asset.Role != "header" || roles[asset.Role] {
			return fmt.Errorf("%s has invalid or duplicate role", path)
		}
		ids[asset.ID], roles[asset.Role] = true, true
		if asset.MediaType != "image/png" || asset.Loading != "bundled" {
			return fmt.Errorf("%s uses an unsupported image profile", path)
		}
		maxBytes, maxWidth, maxHeight, maxPixels := int64(196608), int64(2400), int64(1200), int64(2000000)
		if asset.Role == "avatar" {
			maxBytes, maxWidth, maxHeight, maxPixels = 32768, 512, 512, 262144
		}
		if asset.Size != int64(len(asset.Data)) || asset.Size < 1 || asset.Size > maxBytes || asset.Digest.Algorithm != "sha-256" || len(asset.Digest.Value) != 32 {
			return fmt.Errorf("%s has invalid size or digest", path)
		}
		digest := sha256.Sum256(asset.Data)
		if !bytes.Equal(digest[:], asset.Digest.Value) {
			return fmt.Errorf("%s digest does not match data", path)
		}
		width, height, err := pngDimensions(asset.Data)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		if asset.Width != width || asset.Height != height || width > maxWidth || height > maxHeight || width*height > maxPixels {
			return fmt.Errorf("%s has invalid PNG dimensions", path)
		}
	}
	return nil
}
