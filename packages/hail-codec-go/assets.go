package hailcodec

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"regexp"
)

var assetIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func pngDimensions(data []byte) (int64, int64, error) {
	signature := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	if len(data) < 45 || !bytes.Equal(data[:8], signature) {
		return 0, 0, errors.New("asset data must be a PNG image")
	}
	offset, width, height := 8, int64(0), int64(0)
	header, imageData, endChunk, palette, dataEnded := false, false, false, false, false
	colorType := byte(255)
	for offset+12 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := offset + 12 + length
		if length < 0 || end < offset || end > len(data) {
			return 0, 0, errors.New("asset data contains a truncated PNG chunk")
		}
		chunkType := string(data[offset+4 : offset+8])
		if binary.BigEndian.Uint32(data[offset+8+length:end]) != crc32.ChecksumIEEE(data[offset+4:offset+8+length]) {
			return 0, 0, errors.New("asset PNG has invalid chunk CRC")
		}
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
			depth, color := data[offset+16], data[offset+17]
			valid := map[byte]map[byte]bool{0: {1: true, 2: true, 4: true, 8: true, 16: true}, 2: {8: true, 16: true}, 3: {1: true, 2: true, 4: true, 8: true}, 4: {8: true, 16: true}, 6: {8: true, 16: true}}
			if !valid[color][depth] || data[offset+18] != 0 || data[offset+19] != 0 || data[offset+20] > 1 {
				return 0, 0, errors.New("asset PNG has invalid IHDR profile")
			}
			colorType = color
		case "acTL":
			return 0, 0, errors.New("animated PNG is unsupported")
		case "PLTE":
			if imageData || palette || length == 0 || length%3 != 0 || length > 768 {
				return 0, 0, errors.New("asset PNG has invalid palette")
			}
			palette = true
		case "IDAT":
			if dataEnded {
				return 0, 0, errors.New("asset PNG has nonconsecutive image data")
			}
			imageData = true
		case "IEND":
			if length != 0 || end != len(data) {
				return 0, 0, errors.New("asset PNG has invalid IEND")
			}
			endChunk = true
		default:
			if imageData {
				dataEnded = true
			}
			if data[offset+4] >= 'A' && data[offset+4] <= 'Z' {
				return 0, 0, errors.New("asset PNG has unsupported critical chunk")
			}
		}
		offset = end
		if endChunk {
			break
		}
	}
	if !header || !imageData || !endChunk || width == 0 || height == 0 || colorType == 3 && !palette || (colorType == 0 || colorType == 4) && palette {
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
