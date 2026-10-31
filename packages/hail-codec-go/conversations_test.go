package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestConversationVectors(t *testing.T) {
	raw, err := os.ReadFile("../hail-codec-ts/vectors/conversations-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors manifest
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	key := vectors.TestKeys[0]
	privateKey := ed25519.NewKeyFromSeed(fromHex(t, key.SeedHex))
	verifier := VerifierFunc(func(kid string, data, sig []byte) bool {
		return kid == key.KeyID && ed25519.Verify(fromHex(t, key.PublicKeyHex), data, sig)
	})
	verified := map[string]*VerifiedObject{}
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
			digest := sha256.Sum256(encoded)
			if hex.EncodeToString(digest[:]) != v.PayloadSHA256Hex {
				t.Fatal("payload digest mismatch")
			}
			signed, err := SignPayload(payload, privateKey)
			if err != nil || !bytes.Equal(signed, fromHex(t, v.COSEHex)) {
				t.Fatalf("signature: %v", err)
			}
			digest = sha256.Sum256(signed)
			if hex.EncodeToString(digest[:]) != v.RepresentationSHA256Hex {
				t.Fatal("representation digest mismatch")
			}
			result, err := VerifySignedPayload(v.Type, signed, verifier)
			if err != nil {
				t.Fatal(err)
			}
			verified[v.ID] = result
			if _, err = InspectSignedPayload(EnvelopeType, signed); v.Type != EnvelopeType && err == nil {
				t.Fatal("conversation accepted as envelope")
			}
			signed[len(signed)-1] ^= 1
			if _, err = VerifySignedPayload(v.Type, signed, verifier); err == nil {
				t.Fatal("corrupt signature accepted")
			}
			switch detached := result.Payload().(type) {
			case *Conversation:
				detached.Participants[0] = "changed"
				if result.Payload().(*Conversation).Participants[0] == "changed" {
					t.Fatal("roster aliases verified object")
				}
			case *ConversationRevival:
				detached.DescriptorHash.Value[0] ^= 1
				if bytes.Equal(detached.DescriptorHash.Value, result.Payload().(*ConversationRevival).DescriptorHash.Value) {
					t.Fatal("hash aliases verified object")
				}
			}
		})
	}
	for _, v := range vectors.NegativePayload {
		t.Run(v.ID, func(t *testing.T) {
			if _, err := DecodePayload(v.Type, fromHex(t, v.Hex)); err == nil {
				t.Fatal("invalid conversation accepted")
			}
		})
	}
	descriptor, request := verified["conversation-three"], verified["conversation-revival"]
	if descriptor == nil || request == nil {
		t.Fatal("missing verified fixtures")
	}
	if err := ValidateConversationRevivalBinding(descriptor, request); err != nil {
		t.Fatal(err)
	}
	if err := ValidateConversationRevivalBinding(verified["conversation-maximum"], request); err == nil {
		t.Fatal("changed roster accepted")
	}
	if err := ValidateConversationRevivalBinding(&VerifiedObject{}, request); err == nil {
		t.Fatal("unverified descriptor accepted")
	}
	for _, mutate := range []func(*ConversationRevival){
		func(r *ConversationRevival) { r.From = descriptor.Payload().(*Conversation).Participants[2] },
		func(r *ConversationRevival) { r.To = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz" },
		func(r *ConversationRevival) { r.ConversationID = r.RequestID },
		func(r *ConversationRevival) {
			h := sha256.Sum256(descriptor.PayloadBytes())
			r.DescriptorHash.Value = h[:]
		},
		func(r *ConversationRevival) {
			r.IssuedAt = descriptor.Payload().(*Conversation).CreatedAt - 1
			r.ExpiresAt = r.IssuedAt + 3600
		},
	} {
		changed := request.Payload().(*ConversationRevival)
		mutate(changed)
		signed, err := SignPayload(changed, privateKey)
		if err != nil {
			t.Fatal(err)
		}
		checked, err := VerifySignedPayload(ConversationRevivalType, signed, VerifierFunc(func(kid string, data, sig []byte) bool {
			return kid == changed.From+"#hail-messaging" && ed25519.Verify(fromHex(t, key.PublicKeyHex), data, sig)
		}))
		if err != nil {
			t.Fatal(err)
		}
		if err := ValidateConversationRevivalBinding(descriptor, checked); err == nil {
			t.Fatal("invalid revival binding accepted")
		}
	}
}
