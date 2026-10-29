package hailcodec

import "bytes"

const (
	AddressBindingType         = "hail.address-binding"
	SenderProfileType          = "hail.sender-profile"
	GrantType                  = "hail.grant"
	ConnectionInvitationType   = "hail.connection-invitation"
	ConnectionConfirmationType = "hail.connection-confirmation"
	ConnectionGrantType        = "hail.connection-grant"
	ConnectionControlType      = "hail.connection-control"
	EnvelopeType               = "hail.envelope"
	DeliveryStatusType         = "hail.delivery-status"
	BodySPT1Type               = "hail.body.spt-1"
	BodySPT2Type               = "hail.body.spt-2"
	BodySPT3Type               = "hail.body.spt-3"
)

type Payload interface{ PayloadType() string }

type Digest struct {
	Algorithm string `cbor:"algorithm"`
	Value     []byte `cbor:"value"`
}

type BundledImageAsset struct {
	ID        string `cbor:"id"`
	Role      string `cbor:"role"`
	MediaType string `cbor:"media_type"`
	Loading   string `cbor:"loading"`
	Size      int64  `cbor:"size"`
	Digest    Digest `cbor:"digest"`
	Width     int64  `cbor:"width"`
	Height    int64  `cbor:"height"`
	Data      []byte `cbor:"data"`
}

type AssetManifest struct {
	Version int64               `cbor:"version"`
	Assets  []BundledImageAsset `cbor:"assets"`
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
	Assets              *AssetManifest   `cbor:"assets,omitempty"`
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

type ConnectionInvitation struct {
	Type         string `cbor:"type"`
	Version      int64  `cbor:"version"`
	InvitationID string `cbor:"invitation_id"`
	From         string `cbor:"from"`
	TokenHash    Digest `cbor:"token_hash"`
	IssuedAt     int64  `cbor:"issued_at"`
	ExpiresAt    *int64 `cbor:"expires_at"`
	KeyID        string `cbor:"key_id"`
}

func (ConnectionInvitation) PayloadType() string { return ConnectionInvitationType }

type ConnectionConfirmation struct {
	Type           string `cbor:"type"`
	Version        int64  `cbor:"version"`
	ConfirmationID string `cbor:"confirmation_id"`
	From           string `cbor:"from"`
	To             string `cbor:"to"`
	InvitationID   string `cbor:"invitation_id"`
	InvitationHash Digest `cbor:"invitation_hash"`
	IssuedAt       int64  `cbor:"issued_at"`
	ExpiresAt      int64  `cbor:"expires_at"`
	KeyID          string `cbor:"key_id"`
}

func (ConnectionConfirmation) PayloadType() string { return ConnectionConfirmationType }

type ConnectionConsentContext struct {
	GranteeAddress     string `cbor:"grantee_address"`
	AddressBindingHash Digest `cbor:"address_binding_hash"`
	InvitationHash     Digest `cbor:"invitation_hash"`
	ConfirmationHash   Digest `cbor:"confirmation_hash"`
}
type ConnectionGrant struct {
	Type           string                   `cbor:"type"`
	Version        int64                    `cbor:"version"`
	GrantID        string                   `cbor:"grant_id"`
	ConnectionID   string                   `cbor:"connection_id"`
	Revision       int64                    `cbor:"revision"`
	Previous       []byte                   `cbor:"previous"`
	Grantor        string                   `cbor:"grantor"`
	Grantee        string                   `cbor:"grantee"`
	Status         string                   `cbor:"status"`
	IssuedAt       int64                    `cbor:"issued_at"`
	UpdatedAt      int64                    `cbor:"updated_at"`
	ExpiresAt      *int64                   `cbor:"expires_at"`
	ConsentContext ConnectionConsentContext `cbor:"consent_context"`
	KeyID          string                   `cbor:"key_id"`
}

func (ConnectionGrant) PayloadType() string { return ConnectionGrantType }

type ConnectionControl struct {
	Type         string  `cbor:"type"`
	Version      int64   `cbor:"version"`
	Operation    string  `cbor:"operation"`
	From         string  `cbor:"from"`
	To           string  `cbor:"to"`
	RequestID    string  `cbor:"request_id"`
	ConnectionID *string `cbor:"connection_id"`
	Epoch        int64   `cbor:"epoch"`
	State        string  `cbor:"state"`
	ProofHash    Digest  `cbor:"proof_hash"`
	IssuedAt     int64   `cbor:"issued_at"`
	ExpiresAt    *int64  `cbor:"expires_at"`
	KeyID        string  `cbor:"key_id"`
}

func (ConnectionControl) PayloadType() string { return ConnectionControlType }

type EnvelopeAuthorization struct {
	Type         string `cbor:"type"`
	GrantID      string `cbor:"grant_id,omitempty"`
	ReplyTo      string `cbor:"reply_to,omitempty"`
	ConnectionID string `cbor:"connection_id,omitempty"`
	Epoch        int64  `cbor:"epoch,omitempty"`
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

type MessageReference struct {
	Sender    string `cbor:"sender"`
	MessageID string `cbor:"message_id"`
}

type Envelope struct {
	InReplyTo     *MessageReference     `cbor:"in_reply_to,omitempty"`
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

type SPT2Link struct {
	Key   string `cbor:"_key"`
	Type  string `cbor:"_type"`
	Href  string `cbor:"href"`
	Title string `cbor:"title,omitempty"`
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

type SPT2Span struct {
	Type  string   `cbor:"_type"`
	Text  string   `cbor:"text"`
	Marks []string `cbor:"marks"`
}
type SPT2TextBlock struct {
	Type     string     `cbor:"_type"`
	Style    string     `cbor:"style"`
	Children []SPT2Span `cbor:"children"`
	MarkDefs []SPT2Link `cbor:"markDefs"`
	ListItem string     `cbor:"listItem,omitempty"`
	Level    int64      `cbor:"level,omitempty"`
}
type SPT2Body struct {
	Version int64           `cbor:"version"`
	Profile string          `cbor:"profile"`
	Blocks  []SPT2TextBlock `cbor:"blocks"`
}

func (SPT2Body) PayloadType() string { return BodySPT2Type }

type SPT3Block struct {
	Type     string     `cbor:"_type"`
	Asset    string     `cbor:"asset,omitempty"`
	Alt      string     `cbor:"alt,omitempty"`
	Caption  string     `cbor:"caption,omitempty"`
	Style    string     `cbor:"style,omitempty"`
	Children []SPT2Span `cbor:"children,omitempty"`
	MarkDefs []SPT2Link `cbor:"markDefs,omitempty"`
	ListItem string     `cbor:"listItem,omitempty"`
	Level    int64      `cbor:"level,omitempty"`
}

type SPT3Body struct {
	Version int64         `cbor:"version"`
	Profile string        `cbor:"profile"`
	Assets  AssetManifest `cbor:"assets"`
	Blocks  []SPT3Block   `cbor:"blocks"`
}

func (SPT3Body) PayloadType() string { return BodySPT3Type }

func clonePayload(payload Payload) Payload {
	switch value := payload.(type) {
	case *AddressBinding:
		cloned := *value
		return &cloned
	case *SenderProfile:
		cloned := *value
		cloned.Categories = append([]SenderCategory(nil), value.Categories...)
		if value.Assets != nil {
			assets := *value.Assets
			assets.Assets = append([]BundledImageAsset(nil), value.Assets.Assets...)
			for i := range assets.Assets {
				assets.Assets[i].Digest.Value = bytes.Clone(assets.Assets[i].Digest.Value)
				assets.Assets[i].Data = bytes.Clone(assets.Assets[i].Data)
			}
			cloned.Assets = &assets
		}
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
	case *ConnectionInvitation:
		cloned := *value
		cloned.TokenHash.Value = bytes.Clone(value.TokenHash.Value)
		if value.ExpiresAt != nil {
			expiry := *value.ExpiresAt
			cloned.ExpiresAt = &expiry
		}
		return &cloned
	case *ConnectionConfirmation:
		cloned := *value
		cloned.InvitationHash.Value = bytes.Clone(value.InvitationHash.Value)
		return &cloned
	case *ConnectionGrant:
		cloned := *value
		cloned.Previous = bytes.Clone(value.Previous)
		cloned.ConsentContext.AddressBindingHash.Value = bytes.Clone(value.ConsentContext.AddressBindingHash.Value)
		cloned.ConsentContext.InvitationHash.Value = bytes.Clone(value.ConsentContext.InvitationHash.Value)
		cloned.ConsentContext.ConfirmationHash.Value = bytes.Clone(value.ConsentContext.ConfirmationHash.Value)
		if value.ExpiresAt != nil {
			expiry := *value.ExpiresAt
			cloned.ExpiresAt = &expiry
		}
		return &cloned
	case *ConnectionControl:
		cloned := *value
		cloned.ProofHash.Value = bytes.Clone(value.ProofHash.Value)
		if value.ConnectionID != nil {
			id := *value.ConnectionID
			cloned.ConnectionID = &id
		}
		if value.ExpiresAt != nil {
			expiry := *value.ExpiresAt
			cloned.ExpiresAt = &expiry
		}
		return &cloned
	case *Envelope:
		cloned := *value
		if value.InReplyTo != nil {
			parent := *value.InReplyTo
			cloned.InReplyTo = &parent
		}
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
	case *SPT2Body:
		cloned := *value
		cloned.Blocks = make([]SPT2TextBlock, len(value.Blocks))
		for i, block := range value.Blocks {
			cloned.Blocks[i] = block
			cloned.Blocks[i].MarkDefs = append([]SPT2Link(nil), block.MarkDefs...)
			cloned.Blocks[i].Children = append([]SPT2Span(nil), block.Children...)
			for j := range cloned.Blocks[i].Children {
				cloned.Blocks[i].Children[j].Marks = append([]string(nil), block.Children[j].Marks...)
			}
		}
		return &cloned
	case *SPT3Body:
		cloned := *value
		cloned.Assets.Assets = append([]BundledImageAsset(nil), value.Assets.Assets...)
		for i := range cloned.Assets.Assets {
			cloned.Assets.Assets[i].Digest.Value = bytes.Clone(value.Assets.Assets[i].Digest.Value)
			cloned.Assets.Assets[i].Data = bytes.Clone(value.Assets.Assets[i].Data)
		}
		cloned.Blocks = append([]SPT3Block(nil), value.Blocks...)
		for i := range cloned.Blocks {
			cloned.Blocks[i].Children = append([]SPT2Span(nil), value.Blocks[i].Children...)
			cloned.Blocks[i].MarkDefs = append([]SPT2Link(nil), value.Blocks[i].MarkDefs...)
			for j := range cloned.Blocks[i].Children {
				cloned.Blocks[i].Children[j].Marks = append([]string(nil), value.Blocks[i].Children[j].Marks...)
			}
		}
		return &cloned
	default:
		return nil
	}
}
