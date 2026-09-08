package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"testing"
)

var (
	benchmarkPayload      Payload
	benchmarkObject       any
	benchmarkBytes        []byte
	benchmarkGenericValue any
)

func benchmarkVectors(b *testing.B) (manifest, map[string]positiveVector) {
	b.Helper()
	m := vectors(b)
	byType := make(map[string]positiveVector, len(m.Positive))
	for _, vector := range m.Positive {
		if _, exists := byType[vector.Type]; !exists {
			byType[vector.Type] = vector
		}
	}
	return m, byType
}

func BenchmarkPayloadDecode(b *testing.B) {
	_, byType := benchmarkVectors(b)
	for _, payloadType := range []string{AddressBindingType, EnvelopeType, BodySPT1Type} {
		vector := byType[payloadType]
		encoded := fromHex(b, vector.PayloadHex)
		b.Run(benchmarkName(payloadType), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(encoded)))
			b.ResetTimer()
			for range b.N {
				payload, err := DecodePayload(payloadType, encoded)
				if err != nil {
					b.Fatal(err)
				}
				benchmarkPayload = payload
			}
		})
	}
}

func BenchmarkPayloadEncode(b *testing.B) {
	_, byType := benchmarkVectors(b)
	for _, payloadType := range []string{AddressBindingType, EnvelopeType, BodySPT1Type} {
		vector := byType[payloadType]
		expected := fromHex(b, vector.PayloadHex)
		payload, err := DecodePayload(payloadType, expected)
		if err != nil {
			b.Fatal(err)
		}
		encoded, err := EncodePayload(payload)
		if err != nil || !bytes.Equal(encoded, expected) {
			b.Fatalf("benchmark setup reencode failed: %v", err)
		}
		b.Run(benchmarkName(payloadType), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(expected)))
			b.ResetTimer()
			for range b.N {
				encoded, err := EncodePayload(payload)
				if err != nil {
					b.Fatal(err)
				}
				benchmarkBytes = encoded
			}
		})
	}
}

func BenchmarkCOSEInspect(b *testing.B) {
	_, byType := benchmarkVectors(b)
	vector := byType[EnvelopeType]
	representation := fromHex(b, vector.COSEHex)
	if _, err := InspectSignedPayload(vector.Type, representation); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(representation)))
	b.ResetTimer()
	for range b.N {
		object, err := InspectSignedPayload(vector.Type, representation)
		if err != nil {
			b.Fatal(err)
		}
		benchmarkObject = object
	}
}

func BenchmarkCOSESignEnvelope(b *testing.B) {
	m, byType := benchmarkVectors(b)
	vector := byType[EnvelopeType]
	payload, err := DecodePayload(vector.Type, fromHex(b, vector.PayloadHex))
	if err != nil {
		b.Fatal(err)
	}
	expected := fromHex(b, vector.COSEHex)
	inspected, err := InspectSignedPayload(vector.Type, expected)
	if err != nil {
		b.Fatal(err)
	}
	var privateKey ed25519.PrivateKey
	for _, key := range m.TestKeys {
		if key.KeyID == inspected.KeyID() {
			privateKey = ed25519.NewKeyFromSeed(fromHex(b, key.SeedHex))
			break
		}
	}
	if privateKey == nil {
		b.Fatalf("missing signing key %q", inspected.KeyID())
	}
	representation, err := SignPayload(payload, privateKey)
	if err != nil || !bytes.Equal(representation, expected) {
		b.Fatalf("benchmark setup signature failed: %v", err)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(expected)))
	b.ResetTimer()
	for range b.N {
		representation, err := SignPayload(payload, privateKey)
		if err != nil {
			b.Fatal(err)
		}
		benchmarkBytes = representation
	}
}

func BenchmarkCOSEKeyIDAwareVerifyEnvelope(b *testing.B) {
	m, byType := benchmarkVectors(b)
	vector := byType[EnvelopeType]
	representation := fromHex(b, vector.COSEHex)
	keys := make(map[string]ed25519.PublicKey, len(m.TestKeys))
	for _, key := range m.TestKeys {
		keys[key.KeyID] = ed25519.PublicKey(fromHex(b, key.PublicKeyHex))
	}
	verifier := VerifierFunc(func(keyID string, structure, signature []byte) bool {
		key, ok := keys[keyID]
		return ok && ed25519.Verify(key, structure, signature)
	})
	if _, err := VerifySignedPayload(vector.Type, representation, verifier); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(representation)))
	b.ResetTimer()
	for range b.N {
		object, err := VerifySignedPayload(vector.Type, representation, verifier)
		if err != nil {
			b.Fatal(err)
		}
		benchmarkObject = object
	}
}

func BenchmarkDeterministicCBOR(b *testing.B) {
	_, byType := benchmarkVectors(b)
	encoded := fromHex(b, byType[EnvelopeType].PayloadHex)
	value, err := DecodeDeterministic(encoded)
	if err != nil {
		b.Fatal(err)
	}
	b.Run("decode-envelope", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(encoded)))
		b.ResetTimer()
		for range b.N {
			decoded, err := DecodeDeterministic(encoded)
			if err != nil {
				b.Fatal(err)
			}
			benchmarkGenericValue = decoded
		}
	})
	b.Run("encode-envelope", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(encoded)))
		b.ResetTimer()
		for range b.N {
			result, err := EncodeDeterministic(value)
			if err != nil {
				b.Fatal(err)
			}
			benchmarkBytes = result
		}
	})
}

func benchmarkName(payloadType string) string {
	switch payloadType {
	case AddressBindingType:
		return "address-binding"
	case EnvelopeType:
		return "envelope"
	case BodySPT1Type:
		return "body-spt-1"
	default:
		return payloadType
	}
}
