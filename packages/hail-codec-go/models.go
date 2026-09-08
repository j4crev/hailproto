package hailcodec

import "bytes"

const (
	AddressBindingType = "hail.address-binding"
	SenderProfileType  = "hail.sender-profile"
	GrantType          = "hail.grant"
	EnvelopeType       = "hail.envelope"
	DeliveryStatusType = "hail.delivery-status"
	BodySPT1Type       = "hail.body.spt-1"
)

type Payload interface{ PayloadType() string }

type Digest struct {
	Algorithm string `cbor:"algorithm"`
	Value     []byte `cbor:"value"`
}

type AddressBinding struct {
	Version   int64  `cbor:"version"`
	Type      string `cbor:"type"`
	Address   string `cbor:"address"`
	DID       string `cbor:"did"`
	IssuedAt  int64  `cbor:"issued_at"`
	ExpiresAt int64  `cbor:"expires_at"`
	KeyID     string `cbor:"key_id"`
}

func (AddressBinding) PayloadType() string { return AddressBindingType }

type SenderCategory struct {
	ID          string `cbor:"id"`
	Label       string `cbor:"label"`
	Description string `cbor:"description,omitempty"`
}

type SenderProfile struct {
	Type                string           `cbor:"type"`
	Version             int64            `cbor:"version"`
	DID                 string           `cbor:"did"`
	Revision            int64            `cbor:"revision"`
	DisplayName         string           `cbor:"display_name"`
	Description         string           `cbor:"description,omitempty"`
	OffersUncategorized bool             `cbor:"offers_uncategorized"`
	Categories          []SenderCategory `cbor:"categories"`
	UpdatedAt           int64            `cbor:"updated_at"`
	KeyID               string           `cbor:"key_id"`
}

func (SenderProfile) PayloadType() string { return SenderProfileType }

type GrantScope struct {
	Type   string   `cbor:"type"`
	Values []string `cbor:"values,omitempty"`
}

type ConsentContext struct {
	GranteeAddress     string `cbor:"grantee_address"`
	AddressBindingHash Digest `cbor:"address_binding_hash"`
	SenderProfileHash  Digest `cbor:"sender_profile_hash"`
}

type Grant struct {
	Type           string         `cbor:"type"`
	Version        int64          `cbor:"version"`
	GrantID        string         `cbor:"grant_id"`
	Revision       int64          `cbor:"revision"`
	Previous       []byte         `cbor:"previous"`
	Grantor        string         `cbor:"grantor"`
	Grantee        string         `cbor:"grantee"`
	Scope          []GrantScope   `cbor:"scope"`
	Status         string         `cbor:"status"`
	IssuedAt       int64          `cbor:"issued_at"`
	UpdatedAt      int64          `cbor:"updated_at"`
	ExpiresAt      *int64         `cbor:"expires_at"`
	ConsentContext ConsentContext `cbor:"consent_context"`
	KeyID          string         `cbor:"key_id"`
}

func (Grant) PayloadType() string { return GrantType }

type EnvelopeAuthorization struct {
	Type    string `cbor:"type"`
	GrantID string `cbor:"grant_id,omitempty"`
	ReplyTo string `cbor:"reply_to,omitempty"`
}

type BearerAccess struct {
	Type      string `cbor:"type"`
	Token     []byte `cbor:"token"`
	ExpiresAt int64  `cbor:"expires_at"`
}

type BodyDescriptor struct {
	Digest         Digest       `cbor:"digest"`
	Size           int64        `cbor:"size"`
	MediaType      string       `cbor:"media_type"`
	Profile        string       `cbor:"profile"`
	AvailableUntil int64        `cbor:"available_until"`
	Access         BearerAccess `cbor:"access"`
}

type ReplyPermission struct {
	Allowed bool   `cbor:"allowed"`
	Until   *int64 `cbor:"until,omitempty"`
}

type Envelope struct {
	Type          string                `cbor:"type"`
	Version       int64                 `cbor:"version"`
	MessageID     string                `cbor:"message_id"`
	From          string                `cbor:"from"`
	To            string                `cbor:"to"`
	Authorization EnvelopeAuthorization `cbor:"authorization"`
	Category      string                `cbor:"category,omitempty"`
	MessageType   string                `cbor:"message_type,omitempty"`
	CreatedAt     int64                 `cbor:"created_at"`
	ExpiresAt     int64                 `cbor:"expires_at"`
	Body          BodyDescriptor        `cbor:"body"`
	Reply         ReplyPermission       `cbor:"reply"`
}

func (Envelope) PayloadType() string { return EnvelopeType }

type DeliveryStatus struct {
	Type           string `cbor:"type"`
	Version        int64  `cbor:"version"`
	MessageID      string `cbor:"message_id"`
	EnvelopeDigest Digest `cbor:"envelope_digest"`
	From           string `cbor:"from"`
	To             string `cbor:"to"`
	Revision       int64  `cbor:"revision"`
	State          string `cbor:"state"`
	Reason         string `cbor:"reason,omitempty"`
	RetryAt        *int64 `cbor:"retry_at,omitempty"`
	OccurredAt     int64  `cbor:"occurred_at"`
}

func (DeliveryStatus) PayloadType() string { return DeliveryStatusType }

type SPTSpan struct {
	Type  string   `cbor:"_type"`
	Text  string   `cbor:"text"`
	Marks []string `cbor:"marks"`
}

type SPTTextBlock struct {
	Type     string    `cbor:"_type"`
	Style    string    `cbor:"style"`
	Children []SPTSpan `cbor:"children"`
	MarkDefs []any     `cbor:"markDefs"`
}

type SPTBody struct {
	Version int64          `cbor:"version"`
	Profile string         `cbor:"profile"`
	Blocks  []SPTTextBlock `cbor:"blocks"`
}

func (SPTBody) PayloadType() string { return BodySPT1Type }

func clonePayload(payload Payload) Payload {
	switch value := payload.(type) {
	case *AddressBinding:
		cloned := *value
		return &cloned
	case *SenderProfile:
		cloned := *value
		cloned.Categories = append([]SenderCategory(nil), value.Categories...)
		return &cloned
	case *Grant:
		cloned := *value
		cloned.Previous = bytes.Clone(value.Previous)
		cloned.Scope = make([]GrantScope, len(value.Scope))
		for i, scope := range value.Scope {
			cloned.Scope[i] = scope
			cloned.Scope[i].Values = append([]string(nil), scope.Values...)
		}
		cloned.ConsentContext.AddressBindingHash.Value = bytes.Clone(value.ConsentContext.AddressBindingHash.Value)
		cloned.ConsentContext.SenderProfileHash.Value = bytes.Clone(value.ConsentContext.SenderProfileHash.Value)
		if value.ExpiresAt != nil {
			expires := *value.ExpiresAt
			cloned.ExpiresAt = &expires
		}
		return &cloned
	case *Envelope:
		cloned := *value
		cloned.Body.Digest.Value = bytes.Clone(value.Body.Digest.Value)
		cloned.Body.Access.Token = bytes.Clone(value.Body.Access.Token)
		if value.Reply.Until != nil {
			until := *value.Reply.Until
			cloned.Reply.Until = &until
		}
		return &cloned
	case *DeliveryStatus:
		cloned := *value
		cloned.EnvelopeDigest.Value = bytes.Clone(value.EnvelopeDigest.Value)
		if value.RetryAt != nil {
			retry := *value.RetryAt
			cloned.RetryAt = &retry
		}
		return &cloned
	case *SPTBody:
		cloned := *value
		cloned.Blocks = make([]SPTTextBlock, len(value.Blocks))
		for i, block := range value.Blocks {
			cloned.Blocks[i] = block
			cloned.Blocks[i].Children = make([]SPTSpan, len(block.Children))
			for j, span := range block.Children {
				cloned.Blocks[i].Children[j] = span
				cloned.Blocks[i].Children[j].Marks = append([]string(nil), span.Marks...)
			}
			cloned.Blocks[i].MarkDefs = append([]any(nil), block.MarkDefs...)
		}
		return &cloned
	default:
		return nil
	}
}
