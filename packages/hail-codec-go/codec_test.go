package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type testKeyVector struct {
	KeyID        string `json:"key_id"`
	SeedHex      string `json:"seed_hex"`
	PublicKeyHex string `json:"public_key_hex"`
}
type positiveVector struct {
	ID                            string `json:"id"`
	Type                          string `json:"type"`
	PayloadHex                    string `json:"payload_hex"`
	PayloadSHA256Hex              string `json:"payload_sha256_hex"`
	PayloadSHA256Base64URL        string `json:"payload_sha256_base64url"`
	COSEHex                       string `json:"cose_sign1_hex"`
	SigStructureHex               string `json:"sig_structure_hex"`
	RepresentationSHA256Hex       string `json:"representation_sha256_hex"`
	RepresentationSHA256Base64URL string `json:"representation_sha256_base64url"`
}
type negativeCBORVector struct {
	ID, Hex string
	Limits  *struct {
		MaximumByteStringLength int `json:"maximum_byte_string_length"`
	} `json:"limits"`
}
type negativePayloadVector struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Hex  string `json:"hex"`
}
type negativeCOSEVector struct {
	ID        string `json:"id"`
	Operation string `json:"operation"`
	Type      string `json:"type"`
	Hex       string `json:"hex"`
}
type digestDomainVector struct {
	ID              string `json:"id"`
	SourceVector    string `json:"source_vector"`
	SourceField     string `json:"source_field"`
	TargetVector    string `json:"target_vector"`
	TargetPath      string `json:"target_path"`
	SHA256Hex       string `json:"sha256_hex"`
	SHA256Base64URL string `json:"sha256_base64url"`
}
type manifest struct {
	Format          string                  `json:"format"`
	TestKeys        []testKeyVector         `json:"test_keys"`
	Positive        []positiveVector        `json:"positive"`
	DigestDomains   []digestDomainVector    `json:"digest_domains"`
	NegativeCBOR    []negativeCBORVector    `json:"negative_cbor"`
	NegativePayload []negativePayloadVector `json:"negative_payload"`
	NegativeCOSE    []negativeCOSEVector    `json:"negative_cose"`
}

type customMarshaler struct{ called *bool }

func (value customMarshaler) MarshalCBOR() ([]byte, error) {
	*value.called = true
	return []byte{0x01}, nil
}

func vectors(t testing.TB) manifest {
	t.Helper()
	b, err := os.ReadFile("../hail-codec-ts/vectors/v0.json")
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err = json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
func fromHex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPositiveVectors(t *testing.T) {
	m := vectors(t)
	if m.Format != "hail-conformance-vectors-1" || len(m.Positive) != 7 {
		t.Fatalf("unexpected manifest %q (%d positives)", m.Format, len(m.Positive))
	}
	keys := map[string]testKeyVector{}
	for _, k := range m.TestKeys {
		keys[k.KeyID] = k
	}
	for _, v := range m.Positive {
		t.Run(v.ID, func(t *testing.T) {
			payloadBytes := fromHex(t, v.PayloadHex)
			payload, err := DecodePayload(v.Type, payloadBytes)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := EncodePayload(payload)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(encoded, payloadBytes) {
				t.Fatal("payload reencode differs")
			}
			sum := sha256.Sum256(payloadBytes)
			if hex.EncodeToString(sum[:]) != v.PayloadSHA256Hex || EncodeBase64URL(sum[:]) != v.PayloadSHA256Base64URL {
				t.Fatal("payload digest differs")
			}
			if v.Type == BodySPT1Type {
				if v.COSEHex != "" {
					t.Fatal("body unexpectedly signed")
				}
				return
			}
			representation := fromHex(t, v.COSEHex)
			inspected, err := InspectSignedPayload(v.Type, representation)
			if err != nil {
				t.Fatal(err)
			}
			if inspected.Type() != v.Type {
				t.Fatalf("inspected type = %q, want %q", inspected.Type(), v.Type)
			}
			key, ok := keys[inspected.KeyID()]
			if !ok {
				t.Fatalf("missing key %q", inspected.KeyID())
			}
			seed := fromHex(t, key.SeedHex)
			privateKey := ed25519.NewKeyFromSeed(seed)
			signed, err := SignPayload(payload, privateKey)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(signed, representation) {
				t.Fatal("signed representation differs")
			}
			publicKey := ed25519.PublicKey(fromHex(t, key.PublicKeyHex))
			verified, err := VerifySignedPayload(v.Type, representation, VerifierFunc(func(keyID string, structure, signature []byte) bool {
				return keyID == key.KeyID && ed25519.Verify(publicKey, structure, signature)
			}))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(verified.PayloadBytes(), payloadBytes) {
				t.Fatal("verified payload differs")
			}
			parsed, err := parseCOSE(v.Type, representation)
			if err != nil {
				t.Fatal(err)
			}
			structure, err := SigStructure(parsed.protected, parsed.data.payloadBytes)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(structure, fromHex(t, v.SigStructureHex)) {
				t.Fatal("Sig_structure differs")
			}
			repSum := sha256.Sum256(representation)
			if hex.EncodeToString(repSum[:]) != v.RepresentationSHA256Hex || EncodeBase64URL(repSum[:]) != v.RepresentationSHA256Base64URL {
				t.Fatal("representation digest differs")
			}
		})
	}
}

func TestNegativeVectors(t *testing.T) {
	m := vectors(t)
	for _, v := range m.NegativeCBOR {
		t.Run("cbor/"+v.ID, func(t *testing.T) {
			limits := DefaultResourceLimits()
			if v.Limits != nil {
				limits.MaximumByteStringLength = v.Limits.MaximumByteStringLength
			}
			if _, err := DecodeDeterministicWithLimits(fromHex(t, v.Hex), limits); err == nil {
				t.Fatal("accepted negative CBOR")
			}
		})
	}
	for _, v := range m.NegativePayload {
		t.Run("payload/"+v.ID, func(t *testing.T) {
			if _, err := DecodePayload(v.Type, fromHex(t, v.Hex)); err == nil {
				t.Fatal("accepted negative payload")
			}
		})
	}
	for _, v := range m.NegativeCOSE {
		t.Run("cose/"+v.ID, func(t *testing.T) {
			rep := fromHex(t, v.Hex)
			var err error
			if v.Operation == "verify" {
				keys := map[string]ed25519.PublicKey{}
				for _, key := range m.TestKeys {
					keys[key.KeyID] = ed25519.PublicKey(fromHex(t, key.PublicKeyHex))
				}
				_, err = VerifySignedPayload(v.Type, rep, VerifierFunc(func(keyID string, structure, signature []byte) bool {
					publicKey, ok := keys[keyID]
					return ok && ed25519.Verify(publicKey, structure, signature)
				}))
			} else {
				_, err = InspectSignedPayload(v.Type, rep)
			}
			if err == nil {
				t.Fatal("accepted negative COSE")
			}
		})
	}
}

func TestDigestDomains(t *testing.T) {
	m := vectors(t)
	byID := map[string]positiveVector{}
	for _, v := range m.Positive {
		byID[v.ID] = v
	}
	for _, d := range m.DigestDomains {
		t.Run(d.ID, func(t *testing.T) {
			source := byID[d.SourceVector]
			sourceHex := source.PayloadHex
			if d.SourceField == "cose_sign1_hex" {
				sourceHex = source.COSEHex
			}
			sum := sha256.Sum256(fromHex(t, sourceHex))
			if hex.EncodeToString(sum[:]) != d.SHA256Hex || EncodeBase64URL(sum[:]) != d.SHA256Base64URL {
				t.Fatal("digest domain differs")
			}
			target, err := DecodePayload(byID[d.TargetVector].Type, fromHex(t, byID[d.TargetVector].PayloadHex))
			if err != nil {
				t.Fatal(err)
			}
			var embedded []byte
			switch d.TargetPath {
			case "consent_context.address_binding_hash.value":
				embedded = target.(*Grant).ConsentContext.AddressBindingHash.Value
			case "consent_context.sender_profile_hash.value":
				embedded = target.(*Grant).ConsentContext.SenderProfileHash.Value
			case "previous":
				embedded = target.(*Grant).Previous
			case "body.digest.value":
				embedded = target.(*Envelope).Body.Digest.Value
			case "envelope_digest.value":
				embedded = target.(*DeliveryStatus).EnvelopeDigest.Value
			default:
				t.Fatalf("unhandled target path %q", d.TargetPath)
			}
			if !bytes.Equal(embedded, sum[:]) {
				t.Fatal("digest is not embedded at target boundary")
			}
		})
	}
	body := byID["body-spt-1-basic"]
	envelope := byID["envelope-basic"]
	payloadHash := sha256.Sum256(fromHex(t, envelope.PayloadHex))
	representationHash := sha256.Sum256(fromHex(t, envelope.COSEHex))
	if bytes.Equal(payloadHash[:], representationHash[:]) {
		t.Fatal("payload and signed-representation digest domains collapsed")
	}
	bodyHash := sha256.Sum256(fromHex(t, body.PayloadHex))
	if bytes.Equal(bodyHash[:], payloadHash[:]) {
		t.Fatal("body and envelope digest domains collapsed")
	}
}

func TestSafetyBoundaries(t *testing.T) {
	limits := DefaultResourceLimits()
	limits.MaximumBytes = 1
	if _, err := DecodeDeterministicWithLimits([]byte{0x41, 0}, limits); err == nil {
		t.Fatal("accepted oversized input")
	}
	for _, raw := range [][]byte{{0xf9, 0x3c, 0}, {0xf7}, {0xc1, 0}, {0xa1, 0x01, 0x02}, {0x01, 0x02}} {
		if _, err := DecodeDeterministic(raw); err == nil {
			t.Fatalf("accepted forbidden CBOR %x", raw)
		}
	}
	m := vectors(t)
	rep := fromHex(t, m.Positive[0].COSEHex)
	original := bytes.Clone(rep)
	inspected, err := InspectSignedPayload(AddressBindingType, rep)
	if err != nil {
		t.Fatal(err)
	}
	rep[0] = 0
	got := inspected.RepresentationBytes()
	if !bytes.Equal(got, original) {
		t.Fatal("inspection retained caller storage")
	}
	got[0] = 0
	if inspected.RepresentationBytes()[0] != 0xd2 {
		t.Fatal("representation getter exposed internal storage")
	}
	payload := inspected.PayloadBytes()
	payload[0] = 0
	if inspected.PayloadBytes()[0] == 0 {
		t.Fatal("payload getter exposed internal storage")
	}
	model := inspected.Payload().(*AddressBinding)
	model.Address = "mallory@example.com"
	if inspected.Payload().(*AddressBinding).Address != "alice@example.com" {
		t.Fatal("payload getter exposed internal object state")
	}
	var envelopeVector positiveVector
	for _, vector := range m.Positive {
		if vector.Type == EnvelopeType {
			envelopeVector = vector
			break
		}
	}
	envelopeObject, err := InspectSignedPayload(EnvelopeType, fromHex(t, envelopeVector.COSEHex))
	if err != nil {
		t.Fatal(err)
	}
	envelope := envelopeObject.Payload().(*Envelope)
	envelope.Body.Access.Token[0] ^= 0xff
	if envelopeObject.Payload().(*Envelope).Body.Access.Token[0] != 0x02 {
		t.Fatal("payload getter exposed nested byte storage")
	}
	valid := []byte{0xfb, 0xff}
	encoded := EncodeBase64URL(valid)
	decoded, err := DecodeBase64URL(encoded, 2)
	if err != nil || !bytes.Equal(decoded, valid) {
		t.Fatal("base64url round trip failed")
	}
	for _, bad := range []string{"_x", "Zg==", "Zg+", "A"} {
		if _, err := DecodeBase64URL(bad, -1); err == nil {
			t.Fatalf("accepted noncanonical base64url %q", bad)
		}
	}
}

func TestEncodingSecurityRegressions(t *testing.T) {
	called := false
	if _, err := EncodeDeterministic(customMarshaler{called: &called}); err == nil {
		t.Fatal("accepted custom CBOR marshaler")
	}
	if called {
		t.Fatal("invoked custom CBOR marshaler before rejection")
	}
	limits := DefaultResourceLimits()
	limits.MaximumBytes = 8
	limits.MaximumTextBytes = 1024
	if _, err := EncodeDeterministicWithLimits(strings.Repeat("x", 100), limits); err == nil {
		t.Fatal("accepted oversized direct encode")
	}
	var payload *AddressBinding
	if _, err := EncodePayload(payload); err == nil {
		t.Fatal("accepted typed nil payload")
	}
	for name, value := range map[string]any{
		"bytes":         []byte(nil),
		"array":         []any(nil),
		"string-slice":  []string(nil),
		"map-string":    map[string]any(nil),
		"map-interface": map[any]any(nil),
		"array-pointer": (*[1]int)(nil),
	} {
		t.Run("typed-nil-"+name, func(t *testing.T) {
			if _, err := EncodeDeterministic(value); err == nil {
				t.Fatal("accepted typed nil generic value")
			}
		})
	}
}

func TestTypedCollectionPreflight(t *testing.T) {
	m := vectors(t)
	profilePayload, err := DecodePayload(SenderProfileType, fromHex(t, m.Positive[1].PayloadHex))
	if err != nil {
		t.Fatal(err)
	}
	profile := profilePayload.(*SenderProfile)
	profile.Categories = make([]SenderCategory, 101)
	if _, err := EncodePayload(profile); err == nil {
		t.Fatal("accepted more than 100 typed sender categories")
	}

	body := &SPTBody{Version: 1, Profile: "spt-1", Blocks: make([]SPTTextBlock, DefaultResourceLimits().MaximumArrayLength+1)}
	allocations := testing.AllocsPerRun(1, func() {
		if _, err := EncodePayload(body); err == nil {
			t.Fatal("accepted oversized typed block collection")
		}
	})
	if allocations >= 1000 {
		t.Fatalf("typed preflight allocated as if projecting the collection: %.0f allocations", allocations)
	}

	grantPayload, err := DecodePayload(GrantType, fromHex(t, m.Positive[3].PayloadHex))
	if err != nil {
		t.Fatal(err)
	}
	grant := grantPayload.(*Grant)
	grant.Scope = nil
	if _, err := EncodePayload(grant); err == nil {
		t.Fatal("accepted empty typed grant scope")
	}
}

func TestAddressPublicSuffixes(t *testing.T) {
	for _, address := range []string{"alice@foo.invalid", "alice@github.io"} {
		if err := hailAddress(address, "$.address"); err == nil {
			t.Fatalf("accepted non-registrable address %q", address)
		}
	}
	if err := hailAddress("alice@project.github.io", "$.address"); err != nil {
		t.Fatalf("rejected private registrable domain: %v", err)
	}
}

func TestVerifierReceivesKeyID(t *testing.T) {
	m := vectors(t)
	vector := m.Positive[0]
	expectedKeyID := m.TestKeys[0].KeyID
	called := false
	verified, err := VerifySignedPayload(vector.Type, fromHex(t, vector.COSEHex), VerifierFunc(func(keyID string, structure, signature []byte) bool {
		called = true
		if keyID != expectedKeyID {
			t.Errorf("verifier key ID = %q, want %q", keyID, expectedKeyID)
			return false
		}
		if !bytes.Equal(structure, fromHex(t, vector.SigStructureHex)) {
			t.Error("verifier received the wrong Sig_structure")
			return false
		}
		return ed25519.Verify(ed25519.PublicKey(fromHex(t, m.TestKeys[0].PublicKeyHex)), structure, signature)
	}))
	if err != nil || !called || verified == nil {
		t.Fatalf("key-ID-aware verification failed: %v", err)
	}
	payload := verified.Payload().(*AddressBinding)
	payload.Address = "mallory@example.com"
	if verified.Payload().(*AddressBinding).Address != "alice@example.com" {
		t.Fatal("verified payload getter exposed internal object state")
	}
}

func TestInvalidResourceLimits(t *testing.T) {
	valid := DefaultResourceLimits()
	invalid := []ResourceLimits{
		{MaximumBytes: 0, MaximumDepth: valid.MaximumDepth, MaximumItems: valid.MaximumItems, MaximumArrayLength: valid.MaximumArrayLength, MaximumMapEntries: valid.MaximumMapEntries, MaximumTextBytes: valid.MaximumTextBytes, MaximumByteStringLength: valid.MaximumByteStringLength},
		{MaximumBytes: valid.MaximumBytes, MaximumDepth: -1, MaximumItems: valid.MaximumItems, MaximumArrayLength: valid.MaximumArrayLength, MaximumMapEntries: valid.MaximumMapEntries, MaximumTextBytes: valid.MaximumTextBytes, MaximumByteStringLength: valid.MaximumByteStringLength},
		{MaximumBytes: valid.MaximumBytes, MaximumDepth: valid.MaximumDepth, MaximumItems: 0, MaximumArrayLength: valid.MaximumArrayLength, MaximumMapEntries: valid.MaximumMapEntries, MaximumTextBytes: valid.MaximumTextBytes, MaximumByteStringLength: valid.MaximumByteStringLength},
	}
	for _, field := range []string{"array", "map", "text", "bytes"} {
		limits := valid
		switch field {
		case "array":
			limits.MaximumArrayLength = -1
		case "map":
			limits.MaximumMapEntries = -1
		case "text":
			limits.MaximumTextBytes = -1
		case "bytes":
			limits.MaximumByteStringLength = -1
		}
		invalid = append(invalid, limits)
	}
	for _, limits := range invalid {
		if _, err := EncodeDeterministicWithLimits(nil, limits); err == nil {
			t.Fatal("encoder accepted invalid limits")
		}
		if _, err := DecodeDeterministicWithLimits([]byte{0xf6}, limits); err == nil {
			t.Fatal("decoder accepted invalid limits")
		}
	}
}
