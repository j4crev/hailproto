package hailcodec

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	psl "github.com/weppos/publicsuffix-go/publicsuffix"
	"golang.org/x/net/idna"
	"golang.org/x/text/unicode/norm"
)

var (
	didPattern      = regexp.MustCompile(`^did:plc:[a-z2-7]{24}$`)
	uuidV7Pattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	categoryPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	localPattern    = regexp.MustCompile(`^[a-z0-9!#$%&'*+\-/=?^_` + "`" + `{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_` + "`" + `{|}~]+)*$`)
	domainLabel     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)

func EncodePayload(payload Payload) ([]byte, error) {
	kind, err := validateTypedPayload(payload)
	if err != nil {
		return nil, err
	}
	return encodeValidatedPayload(payload, kind)
}

func encodeValidatedPayload(payload Payload, kind string) ([]byte, error) {
	value, projectedKind, err := payloadValue(payload)
	if err != nil {
		return nil, err
	}
	if projectedKind != kind {
		return nil, errors.New("payload type changed after validation")
	}
	if err := validatePayloadMap(kind, value); err != nil {
		return nil, err
	}
	return EncodeDeterministic(value)
}

func DecodePayload(payloadType string, data []byte) (Payload, error) {
	v, err := DecodeDeterministic(data)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[any]any)
	if !ok {
		return nil, errors.New("payload must be a map")
	}
	if err := validatePayloadMap(payloadType, m); err != nil {
		return nil, err
	}
	var out Payload
	switch payloadType {
	case AddressBindingType:
		out = &AddressBinding{}
	case SenderProfileType:
		out = &SenderProfile{}
	case GrantType:
		out = &Grant{}
	case EnvelopeType:
		out = &Envelope{}
	case DeliveryStatusType:
		out = &DeliveryStatus{}
	case BodySPT1Type:
		out = &SPTBody{}
	default:
		return nil, errors.New("unknown Hail payload type")
	}
	if err := decMode.Unmarshal(data, out); err != nil {
		return nil, fmt.Errorf("decode typed payload: %w", err)
	}
	return out, nil
}

func payloadValue(payload Payload) (map[any]any, string, error) {
	if payload == nil {
		return nil, "", errors.New("nil payload")
	}
	switch value := payload.(type) {
	case AddressBinding:
		return addressBindingValue(&value), AddressBindingType, nil
	case *AddressBinding:
		if value == nil {
			return nil, "", errors.New("nil address-binding payload")
		}
		return addressBindingValue(value), AddressBindingType, nil
	case SenderProfile:
		return senderProfileValue(&value), SenderProfileType, nil
	case *SenderProfile:
		if value == nil {
			return nil, "", errors.New("nil sender-profile payload")
		}
		return senderProfileValue(value), SenderProfileType, nil
	case Grant:
		return grantValue(&value), GrantType, nil
	case *Grant:
		if value == nil {
			return nil, "", errors.New("nil grant payload")
		}
		return grantValue(value), GrantType, nil
	case Envelope:
		return envelopeValue(&value), EnvelopeType, nil
	case *Envelope:
		if value == nil {
			return nil, "", errors.New("nil envelope payload")
		}
		return envelopeValue(value), EnvelopeType, nil
	case DeliveryStatus:
		return deliveryStatusValue(&value), DeliveryStatusType, nil
	case *DeliveryStatus:
		if value == nil {
			return nil, "", errors.New("nil delivery-status payload")
		}
		return deliveryStatusValue(value), DeliveryStatusType, nil
	case SPTBody:
		return bodyValue(&value), BodySPT1Type, nil
	case *SPTBody:
		if value == nil {
			return nil, "", errors.New("nil body payload")
		}
		return bodyValue(value), BodySPT1Type, nil
	default:
		return nil, "", fmt.Errorf("unsupported payload model %T", payload)
	}
}

func digestValue(value Digest) map[any]any {
	return map[any]any{"algorithm": value.Algorithm, "value": value.Value}
}

func addressBindingValue(value *AddressBinding) map[any]any {
	return map[any]any{"version": value.Version, "type": value.Type, "address": value.Address, "did": value.DID, "issued_at": value.IssuedAt, "expires_at": value.ExpiresAt, "key_id": value.KeyID}
}

func senderProfileValue(value *SenderProfile) map[any]any {
	categories := make([]any, len(value.Categories))
	for i, category := range value.Categories {
		item := map[any]any{"id": category.ID, "label": category.Label}
		if category.Description != "" {
			item["description"] = category.Description
		}
		categories[i] = item
	}
	result := map[any]any{"type": value.Type, "version": value.Version, "did": value.DID, "revision": value.Revision, "display_name": value.DisplayName, "offers_uncategorized": value.OffersUncategorized, "categories": categories, "updated_at": value.UpdatedAt, "key_id": value.KeyID}
	if value.Description != "" {
		result["description"] = value.Description
	}
	return result
}

func grantValue(value *Grant) map[any]any {
	scope := make([]any, len(value.Scope))
	for i, selector := range value.Scope {
		item := map[any]any{"type": selector.Type}
		if selector.Type == "categories" || selector.Values != nil {
			values := make([]any, len(selector.Values))
			for j, category := range selector.Values {
				values[j] = category
			}
			item["values"] = values
		}
		scope[i] = item
	}
	var previous any
	if value.Previous != nil {
		previous = value.Previous
	}
	var expires any
	if value.ExpiresAt != nil {
		expires = *value.ExpiresAt
	}
	return map[any]any{
		"type": value.Type, "version": value.Version, "grant_id": value.GrantID, "revision": value.Revision, "previous": previous,
		"grantor": value.Grantor, "grantee": value.Grantee, "scope": scope, "status": value.Status, "issued_at": value.IssuedAt,
		"updated_at": value.UpdatedAt, "expires_at": expires, "consent_context": map[any]any{
			"grantee_address": value.ConsentContext.GranteeAddress, "address_binding_hash": digestValue(value.ConsentContext.AddressBindingHash), "sender_profile_hash": digestValue(value.ConsentContext.SenderProfileHash),
		}, "key_id": value.KeyID,
	}
}

func envelopeValue(value *Envelope) map[any]any {
	authorization := map[any]any{"type": value.Authorization.Type}
	if value.Authorization.GrantID != "" {
		authorization["grant_id"] = value.Authorization.GrantID
	}
	if value.Authorization.ReplyTo != "" {
		authorization["reply_to"] = value.Authorization.ReplyTo
	}
	reply := map[any]any{"allowed": value.Reply.Allowed}
	if value.Reply.Until != nil {
		reply["until"] = *value.Reply.Until
	}
	result := map[any]any{
		"type": value.Type, "version": value.Version, "message_id": value.MessageID, "from": value.From, "to": value.To, "authorization": authorization,
		"created_at": value.CreatedAt, "expires_at": value.ExpiresAt, "body": map[any]any{
			"digest": digestValue(value.Body.Digest), "size": value.Body.Size, "media_type": value.Body.MediaType, "profile": value.Body.Profile,
			"available_until": value.Body.AvailableUntil, "access": map[any]any{"type": value.Body.Access.Type, "token": value.Body.Access.Token, "expires_at": value.Body.Access.ExpiresAt},
		}, "reply": reply,
	}
	if value.Category != "" {
		result["category"] = value.Category
	}
	if value.MessageType != "" {
		result["message_type"] = value.MessageType
	}
	return result
}

func deliveryStatusValue(value *DeliveryStatus) map[any]any {
	result := map[any]any{"type": value.Type, "version": value.Version, "message_id": value.MessageID, "envelope_digest": digestValue(value.EnvelopeDigest), "from": value.From, "to": value.To, "revision": value.Revision, "state": value.State, "occurred_at": value.OccurredAt}
	if value.Reason != "" {
		result["reason"] = value.Reason
	}
	if value.RetryAt != nil {
		result["retry_at"] = *value.RetryAt
	}
	return result
}

func bodyValue(value *SPTBody) map[any]any {
	blocks := make([]any, len(value.Blocks))
	for i, block := range value.Blocks {
		children := make([]any, len(block.Children))
		for j, span := range block.Children {
			marks := make([]any, len(span.Marks))
			for k, mark := range span.Marks {
				marks[k] = mark
			}
			children[j] = map[any]any{"_type": span.Type, "text": span.Text, "marks": marks}
		}
		markDefs := make([]any, len(block.MarkDefs))
		copy(markDefs, block.MarkDefs)
		blocks[i] = map[any]any{"_type": block.Type, "style": block.Style, "children": children, "markDefs": markDefs}
	}
	return map[any]any{"version": value.Version, "profile": value.Profile, "blocks": blocks}
}

func mapValue(v any, path string) (map[any]any, error) {
	m, ok := v.(map[any]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a map", path)
	}
	return m, nil
}
func textValue(v any, path string) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("%s must be text", path)
	}
	return s, nil
}
func intValue(v any, path string, min int64) (int64, error) {
	switch n := v.(type) {
	case int64:
		if n >= min {
			return n, nil
		}
	case uint64:
		if n <= 9007199254740991 && n >= uint64(min) {
			return int64(n), nil
		}
	}
	return 0, fmt.Errorf("%s must be integer >= %d", path, min)
}
func boolValue(v any, path string) (bool, error) {
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be boolean", path)
	}
	return b, nil
}
func arrayValue(v any, path string) ([]any, error) {
	a, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be array", path)
	}
	return a, nil
}
func byteValue(v any, n int, path string) error {
	b, ok := v.([]byte)
	if !ok || len(b) != n {
		return fmt.Errorf("%s must be %d bytes", path, n)
	}
	return nil
}
func has(m map[any]any, k string) bool { _, ok := m[k]; return ok }

func exact(m map[any]any, required, optional []string, path string) error {
	allowed := map[string]bool{}
	for _, k := range required {
		allowed[k] = true
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for k := range m {
		s, ok := k.(string)
		if !ok || !allowed[s] {
			return fmt.Errorf("%s has unknown member", path)
		}
	}
	for _, k := range required {
		if !has(m, k) {
			return fmt.Errorf("%s.%s is required", path, k)
		}
	}
	return nil
}
func expectText(m map[any]any, k, want, path string) error {
	s, e := textValue(m[k], path)
	if e != nil {
		return e
	}
	if s != want {
		return fmt.Errorf("%s must equal %s", path, want)
	}
	return nil
}
func did(v any, path string) (string, error) {
	s, e := textValue(v, path)
	if e != nil || !didPattern.MatchString(s) {
		return "", fmt.Errorf("%s must be canonical did:plc", path)
	}
	return s, nil
}
func uuid(v any, path string) error {
	s, e := textValue(v, path)
	if e != nil || !uuidV7Pattern.MatchString(s) {
		return fmt.Errorf("%s must be UUIDv7", path)
	}
	return nil
}
func category(v any, path string) (string, error) {
	s, e := textValue(v, path)
	if e != nil || !categoryPattern.MatchString(s) {
		return "", fmt.Errorf("%s invalid category", path)
	}
	return s, nil
}
func profileText(v any, min, max int, path string) error {
	s, e := textValue(v, path)
	if e != nil {
		return e
	}
	n := len([]byte(s))
	if n < min || n > max || !utf8.ValidString(s) || !norm.NFC.IsNormalString(s) {
		return fmt.Errorf("%s invalid profile text", path)
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return fmt.Errorf("%s contains control/format", path)
		}
	}
	return nil
}
func digest(v any, path string) error {
	m, e := mapValue(v, path)
	if e != nil {
		return e
	}
	if e = exact(m, []string{"algorithm", "value"}, nil, path); e != nil {
		return e
	}
	if e = expectText(m, "algorithm", "sha-256", path+".algorithm"); e != nil {
		return e
	}
	return byteValue(m["value"], 32, path+".value")
}
func keyID(v any, signer, role, path string) error {
	s, e := textValue(v, path)
	if e != nil || s != signer+"#"+role {
		return fmt.Errorf("%s wrong key role", path)
	}
	return nil
}

func hailAddress(v any, path string) error {
	s, e := textValue(v, path)
	if e != nil {
		return e
	}
	at := strings.LastIndexByte(s, '@')
	if at < 1 {
		return fmt.Errorf("%s invalid address", path)
	}
	local, domain := s[:at], s[at+1:]
	if len(s) > 254 || len(local) > 64 || !localPattern.MatchString(local) || len(domain) == 0 || len(domain) > 253 || !strings.Contains(domain, ".") || domain != strings.ToLower(domain) {
		return fmt.Errorf("%s invalid address", path)
	}
	for _, label := range strings.Split(domain, ".") {
		if !domainLabel.MatchString(label) {
			return fmt.Errorf("%s invalid domain", path)
		}
	}
	canonical, e := idna.Lookup.ToASCII(domain)
	if e != nil || canonical != domain {
		return fmt.Errorf("%s noncanonical IDNA domain", path)
	}
	findOptions := &psl.FindOptions{DefaultRule: nil}
	if psl.DefaultList.Find(domain, findOptions) == nil {
		return fmt.Errorf("%s requires a recognized public suffix", path)
	}
	if _, e := psl.DomainFromListWithOptions(psl.DefaultList, domain, findOptions); e != nil {
		return fmt.Errorf("%s requires registrable public suffix", path)
	}
	return nil
}

func validatePayloadMap(kind string, m map[any]any) error {
	if kind == BodySPT1Type {
		return validateBody(m)
	}
	if e := expectText(m, "type", kind, "$.type"); e != nil {
		return e
	}
	v, e := intValue(m["version"], "$.version", 0)
	if e != nil || v != 1 {
		return errors.New("$.version must equal 1")
	}
	switch kind {
	case AddressBindingType:
		return validateAddressBinding(m)
	case SenderProfileType:
		return validateSenderProfile(m)
	case GrantType:
		return validateGrant(m)
	case EnvelopeType:
		return validateEnvelope(m)
	case DeliveryStatusType:
		return validateDelivery(m)
	}
	return errors.New("unknown Hail payload type")
}

func validateAddressBinding(m map[any]any) error {
	if e := exact(m, []string{"version", "type", "address", "did", "issued_at", "expires_at", "key_id"}, nil, "$"); e != nil {
		return e
	}
	signer, e := did(m["did"], "$.did")
	if e != nil {
		return e
	}
	if e = hailAddress(m["address"], "$.address"); e != nil {
		return e
	}
	issued, e := intValue(m["issued_at"], "$.issued_at", 0)
	if e != nil {
		return e
	}
	expires, e := intValue(m["expires_at"], "$.expires_at", 0)
	if e != nil {
		return e
	}
	if expires <= issued || expires-issued > 7776000 {
		return errors.New("$.expires_at outside validity window")
	}
	return keyID(m["key_id"], signer, "hail-identity", "$.key_id")
}
func validateSenderProfile(m map[any]any) error {
	req := []string{"type", "version", "did", "revision", "display_name", "offers_uncategorized", "categories", "updated_at", "key_id"}
	if e := exact(m, req, []string{"description"}, "$"); e != nil {
		return e
	}
	signer, e := did(m["did"], "$.did")
	if e != nil {
		return e
	}
	if _, e = intValue(m["revision"], "$.revision", 1); e != nil {
		return e
	}
	if e = profileText(m["display_name"], 1, 128, "$.display_name"); e != nil {
		return e
	}
	if has(m, "description") {
		if e = profileText(m["description"], 1, 1024, "$.description"); e != nil {
			return e
		}
	}
	if _, e = boolValue(m["offers_uncategorized"], "$.offers_uncategorized"); e != nil {
		return e
	}
	cats, e := arrayValue(m["categories"], "$.categories")
	if e != nil {
		return e
	}
	if len(cats) > 100 {
		return errors.New("too many categories")
	}
	prev := ""
	for i, v := range cats {
		p := fmt.Sprintf("$.categories[%d]", i)
		c, e := mapValue(v, p)
		if e != nil {
			return e
		}
		if e = exact(c, []string{"id", "label"}, []string{"description"}, p); e != nil {
			return e
		}
		id, e := category(c["id"], p+".id")
		if e != nil || id <= prev {
			return fmt.Errorf("%s IDs not ascending", p)
		}
		prev = id
		if e = profileText(c["label"], 1, 128, p+".label"); e != nil {
			return e
		}
		if has(c, "description") {
			if e = profileText(c["description"], 1, 1024, p+".description"); e != nil {
				return e
			}
		}
	}
	if _, e = intValue(m["updated_at"], "$.updated_at", 0); e != nil {
		return e
	}
	return keyID(m["key_id"], signer, "hail-messaging", "$.key_id")
}
func validateGrant(m map[any]any) error {
	req := []string{"type", "version", "grant_id", "revision", "previous", "grantor", "grantee", "scope", "status", "issued_at", "updated_at", "expires_at", "consent_context", "key_id"}
	if e := exact(m, req, nil, "$"); e != nil {
		return e
	}
	if e := uuid(m["grant_id"], "$.grant_id"); e != nil {
		return e
	}
	rev, e := intValue(m["revision"], "$.revision", 1)
	if e != nil {
		return e
	}
	if rev == 1 {
		if m["previous"] != nil {
			return errors.New("$.previous must be null")
		}
	} else if e = byteValue(m["previous"], 32, "$.previous"); e != nil {
		return e
	}
	signer, e := did(m["grantor"], "$.grantor")
	if e != nil {
		return e
	}
	if _, e = did(m["grantee"], "$.grantee"); e != nil {
		return e
	}
	scope, e := arrayValue(m["scope"], "$.scope")
	if e != nil || len(scope) != 1 {
		return errors.New("$.scope must have one selector")
	}
	sel, e := mapValue(scope[0], "$.scope[0]")
	if e != nil {
		return e
	}
	typ, e := textValue(sel["type"], "$.scope[0].type")
	if e != nil {
		return e
	}
	if typ == "categories" {
		if e = exact(sel, []string{"type", "values"}, nil, "$.scope[0]"); e != nil {
			return e
		}
		vals, e := arrayValue(sel["values"], "$.scope[0].values")
		if e != nil || len(vals) == 0 {
			return errors.New("category scope empty")
		}
		prev := ""
		for _, v := range vals {
			s, e := category(v, "$.scope[0].values")
			if e != nil || s <= prev {
				return errors.New("scope categories not ascending")
			}
			prev = s
		}
	} else if typ == "uncategorized" {
		if e = exact(sel, []string{"type"}, nil, "$.scope[0]"); e != nil {
			return e
		}
	} else {
		return errors.New("unknown scope selector")
	}
	status, e := textValue(m["status"], "$.status")
	if e != nil || (status != "active" && status != "revoked") {
		return errors.New("unknown grant status")
	}
	issued, e := intValue(m["issued_at"], "$.issued_at", 0)
	if e != nil {
		return e
	}
	updated, e := intValue(m["updated_at"], "$.updated_at", 0)
	if e != nil || updated < issued {
		return errors.New("$.updated_at precedes issued_at")
	}
	if m["expires_at"] != nil {
		if _, e = intValue(m["expires_at"], "$.expires_at", 0); e != nil {
			return e
		}
	}
	c, e := mapValue(m["consent_context"], "$.consent_context")
	if e != nil {
		return e
	}
	if e = exact(c, []string{"grantee_address", "address_binding_hash", "sender_profile_hash"}, nil, "$.consent_context"); e != nil {
		return e
	}
	if e = hailAddress(c["grantee_address"], "$.consent_context.grantee_address"); e != nil {
		return e
	}
	if e = digest(c["address_binding_hash"], "$.consent_context.address_binding_hash"); e != nil {
		return e
	}
	if e = digest(c["sender_profile_hash"], "$.consent_context.sender_profile_hash"); e != nil {
		return e
	}
	return keyID(m["key_id"], signer, "hail-identity", "$.key_id")
}

var messageTypes = map[string]bool{"personal": true, "newsletter": true, "promotion": true, "receipt": true, "invoice": true, "ticket": true, "boarding-pass": true, "account-alert": true, "security-alert": true, "package-update": true, "calendar-event": true}

func validateEnvelope(m map[any]any) error {
	req := []string{"type", "version", "message_id", "from", "to", "authorization", "created_at", "expires_at", "body", "reply"}
	if e := exact(m, req, []string{"category", "message_type"}, "$"); e != nil {
		return e
	}
	if e := uuid(m["message_id"], "$.message_id"); e != nil {
		return e
	}
	if _, e := did(m["from"], "$.from"); e != nil {
		return e
	}
	if _, e := did(m["to"], "$.to"); e != nil {
		return e
	}
	a, e := mapValue(m["authorization"], "$.authorization")
	if e != nil {
		return e
	}
	typ, e := textValue(a["type"], "$.authorization.type")
	if e != nil {
		return e
	}
	switch typ {
	case "grant":
		if e = exact(a, []string{"type", "grant_id"}, nil, "$.authorization"); e != nil {
			return e
		}
		if e = uuid(a["grant_id"], "$.authorization.grant_id"); e != nil {
			return e
		}
	case "reply":
		if e = exact(a, []string{"type", "reply_to"}, nil, "$.authorization"); e != nil {
			return e
		}
		if e = uuid(a["reply_to"], "$.authorization.reply_to"); e != nil {
			return e
		}
		if has(m, "category") {
			return errors.New("category prohibited for reply")
		}
	default:
		return errors.New("unknown authorization type")
	}
	if has(m, "category") {
		if _, e = category(m["category"], "$.category"); e != nil {
			return e
		}
	}
	if has(m, "message_type") {
		s, x := textValue(m["message_type"], "$.message_type")
		if x != nil || !messageTypes[s] {
			return errors.New("unknown message type")
		}
	}
	created, e := intValue(m["created_at"], "$.created_at", 0)
	if e != nil {
		return e
	}
	expires, e := intValue(m["expires_at"], "$.expires_at", 0)
	if e != nil || expires <= created || expires-created > 604800 {
		return errors.New("invalid envelope expiry")
	}
	b, e := mapValue(m["body"], "$.body")
	if e != nil {
		return e
	}
	if e = exact(b, []string{"digest", "size", "media_type", "profile", "available_until", "access"}, nil, "$.body"); e != nil {
		return e
	}
	if e = digest(b["digest"], "$.body.digest"); e != nil {
		return e
	}
	size, e := intValue(b["size"], "$.body.size", 1)
	if e != nil || size > 262144 {
		return errors.New("invalid body size")
	}
	if e = expectText(b, "media_type", "application/hail-body+cbor", "$.body.media_type"); e != nil {
		return e
	}
	if e = expectText(b, "profile", "spt-1", "$.body.profile"); e != nil {
		return e
	}
	available, e := intValue(b["available_until"], "$.body.available_until", 0)
	if e != nil || available < created+2592000 || available < expires+300 {
		return errors.New("invalid body availability")
	}
	access, e := mapValue(b["access"], "$.body.access")
	if e != nil {
		return e
	}
	if e = exact(access, []string{"type", "token", "expires_at"}, nil, "$.body.access"); e != nil {
		return e
	}
	if e = expectText(access, "type", "bearer", "$.body.access.type"); e != nil {
		return e
	}
	if e = byteValue(access["token"], 32, "$.body.access.token"); e != nil {
		return e
	}
	accessExpiry, e := intValue(access["expires_at"], "$.body.access.expires_at", 0)
	if e != nil || accessExpiry < available {
		return errors.New("invalid access expiry")
	}
	r, e := mapValue(m["reply"], "$.reply")
	if e != nil {
		return e
	}
	allowed, e := boolValue(r["allowed"], "$.reply.allowed")
	if e != nil {
		return e
	}
	replyReq := []string{"allowed"}
	if allowed {
		replyReq = append(replyReq, "until")
	}
	if e = exact(r, replyReq, nil, "$.reply"); e != nil {
		return e
	}
	if allowed {
		until, e := intValue(r["until"], "$.reply.until", 0)
		if e != nil || until <= created {
			return errors.New("invalid reply expiry")
		}
	}
	return nil
}

var holdReasons = map[string]bool{"sender-unreachable": true, "body-temporarily-unavailable": true, "body-transfer-interrupted": true, "sender-rate-limited": true, "receiver-resource-constrained": true}
var failureReasons = map[string]bool{"body-authorization-failed": true, "body-integrity-failed": true, "body-invalid": true, "body-unsupported": true, "delivery-expired": true, "receiver-policy-rejected": true}
var cancellationReasons = map[string]bool{"recipient-cancelled": true, "receiver-administrative-cancellation": true}

func validateDelivery(m map[any]any) error {
	req := []string{"type", "version", "message_id", "envelope_digest", "from", "to", "revision", "state", "occurred_at"}
	if e := exact(m, req, []string{"reason", "retry_at"}, "$"); e != nil {
		return e
	}
	if e := uuid(m["message_id"], "$.message_id"); e != nil {
		return e
	}
	if e := digest(m["envelope_digest"], "$.envelope_digest"); e != nil {
		return e
	}
	if _, e := did(m["from"], "$.from"); e != nil {
		return e
	}
	if _, e := did(m["to"], "$.to"); e != nil {
		return e
	}
	rev, e := intValue(m["revision"], "$.revision", 1)
	if e != nil {
		return e
	}
	state, e := textValue(m["state"], "$.state")
	if e != nil {
		return e
	}
	validState := state == "accepted" || state == "on-hold" || state == "delivered" || state == "failed" || state == "cancelled"
	if !validState || (rev == 1) != (state == "accepted") {
		return errors.New("invalid delivery state/revision")
	}
	needsReason := state == "on-hold" || state == "failed" || state == "cancelled"
	if needsReason != has(m, "reason") {
		return errors.New("invalid delivery reason presence")
	}
	if needsReason {
		reason, e := textValue(m["reason"], "$.reason")
		if e != nil {
			return e
		}
		allowed := holdReasons
		if state == "failed" {
			allowed = failureReasons
		} else if state == "cancelled" {
			allowed = cancellationReasons
		}
		if !allowed[reason] {
			return errors.New("reason invalid for state")
		}
	}
	occurred, e := intValue(m["occurred_at"], "$.occurred_at", 0)
	if e != nil {
		return e
	}
	if state == "on-hold" {
		if !has(m, "retry_at") {
			return errors.New("retry_at required")
		}
		retry, e := intValue(m["retry_at"], "$.retry_at", 0)
		if e != nil || retry < occurred {
			return errors.New("invalid retry_at")
		}
	} else if has(m, "retry_at") {
		return errors.New("retry_at prohibited")
	}
	return nil
}

func validateBody(m map[any]any) error {
	if e := exact(m, []string{"version", "profile", "blocks"}, nil, "$"); e != nil {
		return e
	}
	v, e := intValue(m["version"], "$.version", 0)
	if e != nil || v != 1 {
		return errors.New("$.version must equal 1")
	}
	if e = expectText(m, "profile", "spt-1", "$.profile"); e != nil {
		return e
	}
	blocks, e := arrayValue(m["blocks"], "$.blocks")
	if e != nil {
		return e
	}
	for i, v := range blocks {
		p := fmt.Sprintf("$.blocks[%d]", i)
		b, e := mapValue(v, p)
		if e != nil {
			return e
		}
		if e = exact(b, []string{"_type", "style", "children", "markDefs"}, nil, p); e != nil {
			return e
		}
		if e = expectText(b, "_type", "block", p+"._type"); e != nil {
			return e
		}
		if e = expectText(b, "style", "normal", p+".style"); e != nil {
			return e
		}
		defs, e := arrayValue(b["markDefs"], p+".markDefs")
		if e != nil || len(defs) != 0 {
			return errors.New("markDefs must be empty")
		}
		children, e := arrayValue(b["children"], p+".children")
		if e != nil || len(children) == 0 {
			return errors.New("block children must not be empty")
		}
		for j, v := range children {
			cp := fmt.Sprintf("%s.children[%d]", p, j)
			s, e := mapValue(v, cp)
			if e != nil {
				return e
			}
			if e = exact(s, []string{"_type", "text", "marks"}, nil, cp); e != nil {
				return e
			}
			if e = expectText(s, "_type", "span", cp+"._type"); e != nil {
				return e
			}
			if _, e = textValue(s["text"], cp+".text"); e != nil {
				return e
			}
			marks, e := arrayValue(s["marks"], cp+".marks")
			if e != nil || len(marks) != 0 {
				return errors.New("marks must be empty")
			}
		}
	}
	return nil
}
