package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/fxamacker/cbor/v2"
)

const (
	COSESign1Tag          = 18
	COSEEd25519Algorithm  = -19
	COSEAlgorithmHeader   = 1
	COSEContentTypeHeader = 3
	COSEKeyIDHeader       = 4
)

type signedProfile struct {
	contentType, keyRole string
	maximumBytes         int
}

var signedProfiles = map[string]signedProfile{
	AddressBindingType: {"application/hail-address-binding+cbor", "hail-identity", 16384},
	SenderProfileType:  {"application/hail-sender-profile+cbor", "hail-messaging", 65536},
	GrantType:          {"application/hail-grant+cbor", "hail-identity", 262144},
	EnvelopeType:       {"application/hail-envelope+cbor", "hail-messaging", 16384},
	DeliveryStatusType: {"application/hail-delivery-status+cbor", "hail-messaging", 16384},
}

var coseEncMode cbor.EncMode
var coseDecMode cbor.DecMode

func init() {
	var err error
	coseEncMode, err = (cbor.EncOptions{Sort: cbor.SortCanonical, TagsMd: cbor.TagsAllowed}).EncMode()
	if err != nil {
		panic(err)
	}
	coseDecMode, err = (cbor.DecOptions{DupMapKey: cbor.DupMapKeyEnforcedAPF, IndefLength: cbor.IndefLengthForbidden, TagsMd: cbor.TagsAllowed, IntDec: cbor.IntDecConvertNone, MapKeyByteString: cbor.MapKeyByteStringForbidden, UTF8: cbor.UTF8RejectInvalid}).DecMode()
	if err != nil {
		panic(err)
	}
}

type authenticatedData struct {
	payload             Payload
	payloadBytes        []byte
	representationBytes []byte
}

type InspectedObject struct {
	payloadType string
	keyID       string
	data        *authenticatedData
}

func (o *InspectedObject) Type() string         { return o.payloadType }
func (o *InspectedObject) KeyID() string        { return o.keyID }
func (o *InspectedObject) Payload() Payload     { return clonePayload(o.data.payload) }
func (o *InspectedObject) PayloadBytes() []byte { return bytes.Clone(o.data.payloadBytes) }
func (o *InspectedObject) RepresentationBytes() []byte {
	return bytes.Clone(o.data.representationBytes)
}

type VerifiedObject struct {
	payloadType string
	keyID       string
	data        *authenticatedData
}

func (o *VerifiedObject) Type() string                { return o.payloadType }
func (o *VerifiedObject) KeyID() string               { return o.keyID }
func (o *VerifiedObject) Payload() Payload            { return clonePayload(o.data.payload) }
func (o *VerifiedObject) PayloadBytes() []byte        { return bytes.Clone(o.data.payloadBytes) }
func (o *VerifiedObject) RepresentationBytes() []byte { return bytes.Clone(o.data.representationBytes) }

type Verifier interface {
	Verify(keyID string, sigStructure, signature []byte) bool
}

type VerifierFunc func(keyID string, sigStructure, signature []byte) bool

func (f VerifierFunc) Verify(keyID string, sigStructure, signature []byte) bool {
	return f(keyID, sigStructure, signature)
}

type parsedCOSE struct {
	kind, keyID          string
	data                 *authenticatedData
	protected, signature []byte
}

func coseLimits(maximumBytes int) ResourceLimits {
	return ResourceLimits{maximumBytes, 8, 256, 8, 8, 1024, maximumBytes}
}

func expectedKeyID(kind string, payload Payload) (string, error) {
	profile, ok := signedProfiles[kind]
	if !ok {
		return "", errors.New("payload family is not signed")
	}
	var signer string
	switch value := payload.(type) {
	case AddressBinding:
		signer = value.DID
	case *AddressBinding:
		if value == nil {
			return "", errors.New("nil address-binding payload")
		}
		signer = value.DID
	case SenderProfile:
		signer = value.DID
	case *SenderProfile:
		if value == nil {
			return "", errors.New("nil sender-profile payload")
		}
		signer = value.DID
	case Grant:
		signer = value.Grantor
	case *Grant:
		if value == nil {
			return "", errors.New("nil grant payload")
		}
		signer = value.Grantor
	case Envelope:
		signer = value.From
	case *Envelope:
		if value == nil {
			return "", errors.New("nil envelope payload")
		}
		signer = value.From
	case DeliveryStatus:
		signer = value.From
	case *DeliveryStatus:
		if value == nil {
			return "", errors.New("nil delivery-status payload")
		}
		signer = value.From
	default:
		return "", fmt.Errorf("unsupported signed payload %T", payload)
	}
	return signer + "#" + profile.keyRole, nil
}

func embeddedKeyID(payload Payload) string {
	switch value := payload.(type) {
	case *AddressBinding:
		return value.KeyID
	case *SenderProfile:
		return value.KeyID
	case *Grant:
		return value.KeyID
	default:
		return ""
	}
}

func SigStructure(protected, payload []byte) ([]byte, error) {
	b, err := coseEncMode.Marshal([]any{"Signature1", bytes.Clone(protected), []byte{}, bytes.Clone(payload)})
	if err != nil {
		return nil, err
	}
	return bytes.Clone(b), nil
}

func SignPayload(payload Payload, privateKey ed25519.PrivateKey) ([]byte, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("Ed25519 private key must be 64 bytes")
	}
	kind, err := validateTypedPayload(payload)
	if err != nil {
		return nil, err
	}
	profile, ok := signedProfiles[kind]
	if !ok {
		return nil, errors.New("payload family is not signed")
	}
	payloadBytes, err := encodeValidatedPayload(payload, kind)
	if err != nil {
		return nil, err
	}
	keyID, err := expectedKeyID(kind, payload)
	if err != nil {
		return nil, err
	}
	protected := map[any]any{uint64(COSEAlgorithmHeader): int64(COSEEd25519Algorithm), uint64(COSEContentTypeHeader): profile.contentType, uint64(COSEKeyIDHeader): []byte(keyID)}
	protectedBytes, err := coseEncMode.Marshal(protected)
	if err != nil {
		return nil, err
	}
	toSign, err := SigStructure(protectedBytes, payloadBytes)
	if err != nil {
		return nil, err
	}
	signature := ed25519.Sign(privateKey, toSign)
	representation, err := coseEncMode.Marshal(cbor.Tag{Number: COSESign1Tag, Content: []any{protectedBytes, map[any]any{}, payloadBytes, signature}})
	if err != nil {
		return nil, err
	}
	if len(representation) > profile.maximumBytes {
		return nil, errors.New("signed representation too large")
	}
	return bytes.Clone(representation), nil
}

func InspectSignedPayload(kind string, representation []byte) (*InspectedObject, error) {
	parsed, err := parseCOSE(kind, representation)
	if err != nil {
		return nil, err
	}
	return &InspectedObject{payloadType: parsed.kind, keyID: parsed.keyID, data: parsed.data}, nil
}

func VerifySignedPayload(kind string, representation []byte, verifier Verifier) (*VerifiedObject, error) {
	if verifier == nil {
		return nil, errors.New("verifier is required")
	}
	parsed, err := parseCOSE(kind, representation)
	if err != nil {
		return nil, err
	}
	structure, err := SigStructure(parsed.protected, parsed.data.payloadBytes)
	if err != nil {
		return nil, err
	}
	if !verifier.Verify(parsed.keyID, bytes.Clone(structure), bytes.Clone(parsed.signature)) {
		return nil, errors.New("invalid signature")
	}
	return &VerifiedObject{payloadType: parsed.kind, keyID: parsed.keyID, data: parsed.data}, nil
}

func parseCOSE(kind string, representation []byte) (*parsedCOSE, error) {
	profile, ok := signedProfiles[kind]
	if !ok {
		return nil, errors.New("unknown signed payload type")
	}
	if len(representation) > profile.maximumBytes {
		return nil, errors.New("signed representation too large")
	}
	if len(representation) == 0 || representation[0] != 0xd2 {
		return nil, errors.New("COSE_Sign1 must begin with tag 18")
	}
	representationBytes := bytes.Clone(representation)
	if err := scanCBOR(representationBytes, coseLimits(profile.maximumBytes), true, false); err != nil {
		return nil, fmt.Errorf("invalid COSE: %w", err)
	}
	var tagged cbor.Tag
	if err := coseDecMode.Unmarshal(representationBytes, &tagged); err != nil {
		return nil, fmt.Errorf("invalid COSE: %w", err)
	}
	if tagged.Number != COSESign1Tag {
		return nil, errors.New("COSE tag 18 required")
	}
	canonical, err := coseEncMode.Marshal(tagged)
	if err != nil || !bytes.Equal(canonical, representationBytes) {
		return nil, errors.New("COSE is not deterministic")
	}
	items, ok := tagged.Content.([]any)
	if !ok || len(items) != 4 {
		return nil, errors.New("COSE_Sign1 must have exactly four elements")
	}
	protected, ok := items[0].([]byte)
	if !ok {
		return nil, errors.New("protected header must be bytes")
	}
	unprotected, ok := items[1].(map[any]any)
	if !ok || len(unprotected) != 0 {
		return nil, errors.New("unprotected header must be empty")
	}
	payloadBytes, ok := items[2].([]byte)
	if !ok {
		return nil, errors.New("embedded payload required")
	}
	signature, ok := items[3].([]byte)
	if !ok || len(signature) != ed25519.SignatureSize {
		return nil, errors.New("signature must be 64 bytes")
	}
	if err := scanCBOR(protected, coseLimits(1024), false, false); err != nil {
		return nil, fmt.Errorf("invalid protected header: %w", err)
	}
	var header map[any]any
	if err := decMode.Unmarshal(protected, &header); err != nil {
		return nil, fmt.Errorf("invalid protected header: %w", err)
	}
	if len(header) != 3 {
		return nil, errors.New("protected header must have exactly three labels")
	}
	headerCanonical, err := coseEncMode.Marshal(header)
	if err != nil || !bytes.Equal(headerCanonical, protected) {
		return nil, errors.New("protected header is not deterministic")
	}
	alg, algOK := header[uint64(COSEAlgorithmHeader)].(int64)
	if !algOK || alg != COSEEd25519Algorithm {
		return nil, errors.New("unsupported algorithm")
	}
	content, contentOK := header[uint64(COSEContentTypeHeader)].(string)
	if !contentOK || content != profile.contentType {
		return nil, errors.New("wrong content type")
	}
	kid, kidOK := header[uint64(COSEKeyIDHeader)].([]byte)
	if !kidOK || !utf8.Valid(kid) {
		return nil, errors.New("protected kid must be UTF-8 bytes")
	}
	for key := range header {
		label, ok := key.(uint64)
		if !ok || (label != 1 && label != 3 && label != 4) {
			return nil, errors.New("unknown protected label")
		}
	}
	payload, err := DecodePayload(kind, payloadBytes)
	if err != nil {
		return nil, err
	}
	expected, err := expectedKeyID(kind, payload)
	if err != nil {
		return nil, err
	}
	keyID := string(kid)
	if keyID != expected {
		return nil, errors.New("wrong key role")
	}
	if payloadKeyID := embeddedKeyID(payload); payloadKeyID != "" && payloadKeyID != keyID {
		return nil, errors.New("payload key_id does not match protected kid")
	}
	data := &authenticatedData{payload: clonePayload(payload), payloadBytes: bytes.Clone(payloadBytes), representationBytes: representationBytes}
	return &parsedCOSE{kind: kind, keyID: keyID, data: data, protected: bytes.Clone(protected), signature: bytes.Clone(signature)}, nil
}
