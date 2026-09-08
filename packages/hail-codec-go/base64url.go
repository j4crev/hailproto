package hailcodec

import (
	"encoding/base64"
	"errors"
)

func EncodeBase64URL(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func DecodeBase64URL(value string, expectedLength int) ([]byte, error) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(b) != value {
		return nil, errors.New("invalid canonical unpadded base64url")
	}
	if expectedLength >= 0 && len(b) != expectedLength {
		return nil, errors.New("unexpected decoded length")
	}
	return b, nil
}
