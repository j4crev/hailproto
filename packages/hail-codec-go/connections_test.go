package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"os"
	"testing"
)

func TestDraftConnectionVectors(t *testing.T) {
	raw, err := os.ReadFile("../hail-codec-ts/vectors/connections-draft.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors manifest
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Format != "hail-connection-draft-vectors-1" || len(vectors.Positive) != 6 || len(vectors.NegativePayload) != 11 {
		t.Fatal("unexpected connection vectors")
	}
	keys := map[string]testKeyVector{}
	for _, key := range vectors.TestKeys {
		keys[key.KeyID] = key
	}
	verifier := VerifierFunc(func(kid string, data, sig []byte) bool {
		key, ok := keys[kid]
		return ok && ed25519.Verify(fromHex(t, key.PublicKeyHex), data, sig)
	})
	for _, vector := range vectors.Positive {
		t.Run(vector.ID, func(t *testing.T) {
			payload, err := DecodePayload(vector.Type, fromHex(t, vector.PayloadHex))
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := EncodePayload(payload)
			if err != nil || !bytes.Equal(encoded, fromHex(t, vector.PayloadHex)) {
				t.Fatalf("connection roundtrip: %v", err)
			}
			digest := sha256.Sum256(encoded)
			if !bytes.Equal(digest[:], fromHex(t, vector.PayloadSHA256Hex)) {
				t.Fatal("payload digest differs")
			}
			var kid string
			switch p := payload.(type) {
			case *ConnectionInvitation:
				kid = p.KeyID
			case *ConnectionConfirmation:
				kid = p.KeyID
			case *ConnectionGrant:
				kid = p.KeyID
			default:
				t.Fatal("unexpected model")
			}
			signed, err := SignPayload(payload, ed25519.NewKeyFromSeed(fromHex(t, keys[kid].SeedHex)))
			if err != nil || !bytes.Equal(signed, fromHex(t, vector.COSEHex)) {
				t.Fatalf("connection signature differs: %v", err)
			}
			if _, err = VerifySignedPayload(vector.Type, signed, verifier); err != nil {
				t.Fatal(err)
			}
			if _, err = InspectSignedPayload(GrantType, signed); err == nil {
				t.Fatal("connection authority accepted as subscription")
			}
			if _, err = InspectSignedPayload(EnvelopeType, signed); err == nil {
				t.Fatal("connection authority accepted as message")
			}
			inspected, err := InspectSignedPayload(vector.Type, signed)
			if err != nil {
				t.Fatal(err)
			}
			switch p := inspected.Payload().(type) {
			case *ConnectionInvitation:
				p.TokenHash.Value[0] ^= 1
				if p.ExpiresAt != nil {
					*p.ExpiresAt = 0
				}
			case *ConnectionConfirmation:
				p.InvitationHash.Value[0] ^= 1
			case *ConnectionGrant:
				p.ConsentContext.InvitationHash.Value[0] ^= 1
				if len(p.Previous) > 0 {
					p.Previous[0] ^= 1
				}
				if p.ExpiresAt != nil {
					*p.ExpiresAt = 0
				}
			}
			clone, err := EncodePayload(inspected.Payload())
			if err != nil || !bytes.Equal(clone, encoded) {
				t.Fatal("mutable connection payload alias")
			}
		})
	}
	for _, vector := range vectors.NegativePayload {
		t.Run(vector.ID, func(t *testing.T) {
			if _, err := DecodePayload(vector.Type, fromHex(t, vector.Hex)); err == nil {
				t.Fatal("malformed connection accepted")
			}
		})
	}
}
