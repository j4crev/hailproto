package hailcodec

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestPublishedResourceBudgets(t *testing.T) {
	var fixture struct {
		Vectors []struct {
			ID       string `json:"id"`
			Segments []struct {
				Hex    string
				Repeat int
			}
			Length   int
			SHA256   string
			Accepted bool
			Limits   map[string]int
		}
	}
	data, err := os.ReadFile("../../spec/vectors/cbor-resource-limits.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, v := range fixture.Vectors {
		t.Run(v.ID, func(t *testing.T) {
			var encoded []byte
			for _, part := range v.Segments {
				raw, err := hex.DecodeString(part.Hex)
				if err != nil {
					t.Fatal(err)
				}
				encoded = append(encoded, bytes.Repeat(raw, part.Repeat)...)
			}
			digest := sha256.Sum256(encoded)
			if len(encoded) != v.Length || hex.EncodeToString(digest[:]) != v.SHA256 {
				t.Fatal("fixture expansion differs")
			}
			limits := DefaultResourceLimits()
			for key, value := range v.Limits {
				switch key {
				case "maximumItems":
					limits.MaximumItems = value
				case "maximumTextBytes":
					limits.MaximumTextBytes = value
				case "maximumByteStringLength":
					limits.MaximumByteStringLength = value
				default:
					t.Fatalf("unknown fixture limit %s", key)
				}
			}
			value, err := DecodeDeterministicWithLimits(encoded, limits)
			scanErr := scanCBOR(encoded, limits, false, true)
			if (scanErr == nil) != v.Accepted {
				t.Fatalf("pre-allocation scanner acceptance differs: %v", scanErr)
			}
			if !v.Accepted {
				if err == nil || !strings.Contains(err.Error(), "resource limit") {
					t.Fatalf("expected resource rejection, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			roundtrip, err := EncodeDeterministicWithLimits(value, limits)
			if err != nil || !bytes.Equal(encoded, roundtrip) {
				t.Fatalf("roundtrip failed: %v", err)
			}
		})
	}
}

func TestEnvelopeOneMiBBodyDescriptor(t *testing.T) {
	for _, vector := range vectors(t).Positive {
		if vector.Type != EnvelopeType {
			continue
		}
		payload, err := DecodePayload(EnvelopeType, fromHex(t, vector.PayloadHex))
		if err != nil {
			t.Fatal(err)
		}
		envelope := payload.(*Envelope)
		envelope.Body.Size = 1048576
		encoded, err := EncodePayload(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodePayload(EnvelopeType, encoded); err != nil {
			t.Fatal(err)
		}
		envelope.Body.Size++
		if _, err := EncodePayload(envelope); err == nil {
			t.Fatal("accepted oversized body descriptor")
		}
		return
	}
	t.Fatal("missing envelope fixture")
}
