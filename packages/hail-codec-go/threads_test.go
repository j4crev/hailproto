package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"testing"
)

func TestThreadVectors(t *testing.T) {
	raw, err := os.ReadFile("../hail-codec-ts/vectors/threads-v3.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors manifest
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	key := vectors.TestKeys[0]
	for _, v := range vectors.Positive {
		t.Run(v.ID, func(t *testing.T) {
			payload, err := DecodePayload(v.Type, fromHex(t, v.PayloadHex))
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := EncodePayload(payload)
			if err != nil || !bytes.Equal(encoded, fromHex(t, v.PayloadHex)) {
				t.Fatalf("roundtrip: %v", err)
			}
			signed, err := SignPayload(payload, ed25519.NewKeyFromSeed(fromHex(t, key.SeedHex)))
			if err != nil || !bytes.Equal(signed, fromHex(t, v.COSEHex)) {
				t.Fatalf("signature: %v", err)
			}
			if _, err = VerifySignedPayload(v.Type, signed, VerifierFunc(func(kid string, data, sig []byte) bool {
				return kid == key.KeyID && ed25519.Verify(fromHex(t, key.PublicKeyHex), data, sig)
			})); err != nil {
				t.Fatal(err)
			}
			inspected, err := InspectSignedPayload(EnvelopeType, signed)
			if err != nil {
				t.Fatal(err)
			}
			detached := inspected.Payload().(*Envelope)
			detached.InReplyTo.Sender = "changed"
			if inspected.Payload().(*Envelope).InReplyTo.Sender == "changed" {
				t.Fatal("inspection parent aliases internal state")
			}
			parent := payload.(*Envelope).InReplyTo
			if parent == nil {
				t.Fatal("lost parent")
			}
			payload.(*Envelope).Version = 2
			if _, err = EncodePayload(payload); err == nil {
				t.Fatal("legacy encoder accepted parent")
			}
		})
	}
	for _, v := range vectors.NegativePayload {
		t.Run(v.ID, func(t *testing.T) {
			if _, err := DecodePayload(v.Type, fromHex(t, v.Hex)); err == nil {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
}
