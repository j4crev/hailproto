package hailcodec

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf8"
)

func validateTypedPayload(payload Payload) (string, error) {
	if payload == nil {
		return "", errors.New("nil payload")
	}
	var kind string
	var value reflect.Value
	var validate func() error
	switch typed := payload.(type) {
	case AddressBinding:
		kind, value = AddressBindingType, reflect.ValueOf(typed)
		validate = func() error { return preflightAddressBinding(&typed) }
	case *AddressBinding:
		if typed == nil {
			return "", errors.New("nil address-binding payload")
		}
		kind, value = AddressBindingType, reflect.ValueOf(*typed)
		validate = func() error { return preflightAddressBinding(typed) }
	case SenderProfile:
		kind, value = SenderProfileType, reflect.ValueOf(typed)
		validate = func() error { return preflightSenderProfile(&typed) }
	case *SenderProfile:
		if typed == nil {
			return "", errors.New("nil sender-profile payload")
		}
		kind, value = SenderProfileType, reflect.ValueOf(*typed)
		validate = func() error { return preflightSenderProfile(typed) }
	case Grant:
		kind, value = GrantType, reflect.ValueOf(typed)
		validate = func() error { return preflightGrant(&typed) }
	case *Grant:
		if typed == nil {
			return "", errors.New("nil grant payload")
		}
		kind, value = GrantType, reflect.ValueOf(*typed)
		validate = func() error { return preflightGrant(typed) }
	case Envelope:
		kind, value = EnvelopeType, reflect.ValueOf(typed)
		validate = func() error { return preflightEnvelope(&typed) }
	case *Envelope:
		if typed == nil {
			return "", errors.New("nil envelope payload")
		}
		kind, value = EnvelopeType, reflect.ValueOf(*typed)
		validate = func() error { return preflightEnvelope(typed) }
	case DeliveryStatus:
		kind, value = DeliveryStatusType, reflect.ValueOf(typed)
		validate = func() error { return preflightDelivery(&typed) }
	case *DeliveryStatus:
		if typed == nil {
			return "", errors.New("nil delivery-status payload")
		}
		kind, value = DeliveryStatusType, reflect.ValueOf(*typed)
		validate = func() error { return preflightDelivery(typed) }
	case SPTBody:
		kind, value = BodySPT1Type, reflect.ValueOf(typed)
		validate = func() error { return preflightBody(&typed) }
	case *SPTBody:
		if typed == nil {
			return "", errors.New("nil body payload")
		}
		kind, value = BodySPT1Type, reflect.ValueOf(*typed)
		validate = func() error { return preflightBody(typed) }
	default:
		return "", fmt.Errorf("unsupported payload model %T", payload)
	}
	limits := DefaultResourceLimits()
	count := 0
	size, err := preflightTrustedValue(value, limits, 0, &count, false)
	if err != nil {
		return "", err
	}
	if size > uint64(limits.MaximumBytes) {
		return "", errors.New("resource limit: encoded payload too large")
	}
	if err := validate(); err != nil {
		return "", err
	}
	return kind, nil
}

func preflightAddressBinding(v *AddressBinding) error {
	if v.Type != AddressBindingType || v.Version != 1 {
		return errors.New("invalid address-binding type or version")
	}
	if err := hailAddress(v.Address, "$.address"); err != nil {
		return err
	}
	if _, err := did(v.DID, "$.did"); err != nil {
		return err
	}
	if v.IssuedAt < 0 || v.ExpiresAt <= v.IssuedAt || v.ExpiresAt-v.IssuedAt > 7776000 {
		return errors.New("invalid address-binding validity window")
	}
	return keyID(v.KeyID, v.DID, "hail-identity", "$.key_id")
}

func preflightSenderProfile(v *SenderProfile) error {
	if v.Type != SenderProfileType || v.Version != 1 || v.Revision < 1 {
		return errors.New("invalid sender-profile type, version, or revision")
	}
	if _, err := did(v.DID, "$.did"); err != nil {
		return err
	}
	if err := profileText(v.DisplayName, 1, 128, "$.display_name"); err != nil {
		return err
	}
	if v.Description != "" {
		if err := profileText(v.Description, 1, 1024, "$.description"); err != nil {
			return err
		}
	}
	if len(v.Categories) > 100 {
		return errors.New("too many sender categories")
	}
	previous := ""
	for i, item := range v.Categories {
		id, err := category(item.ID, fmt.Sprintf("$.categories[%d].id", i))
		if err != nil || id <= previous {
			return errors.New("category IDs must be unique and ascending")
		}
		previous = id
		if err := profileText(item.Label, 1, 128, "$.categories.label"); err != nil {
			return err
		}
		if item.Description != "" {
			if err := profileText(item.Description, 1, 1024, "$.categories.description"); err != nil {
				return err
			}
		}
	}
	if v.UpdatedAt < 0 {
		return errors.New("updated_at must be nonnegative")
	}
	return keyID(v.KeyID, v.DID, "hail-messaging", "$.key_id")
}

func preflightGrant(v *Grant) error {
	if v.Type != GrantType || v.Version != 1 || v.Revision < 1 {
		return errors.New("invalid grant type, version, or revision")
	}
	if err := uuid(v.GrantID, "$.grant_id"); err != nil {
		return err
	}
	if (v.Revision == 1 && v.Previous != nil) || (v.Revision > 1 && len(v.Previous) != 32) {
		return errors.New("invalid grant previous digest")
	}
	if _, err := did(v.Grantor, "$.grantor"); err != nil {
		return err
	}
	if _, err := did(v.Grantee, "$.grantee"); err != nil {
		return err
	}
	if len(v.Scope) != 1 {
		return errors.New("grant scope must contain exactly one selector")
	}
	selector := v.Scope[0]
	if selector.Type == "categories" {
		if len(selector.Values) == 0 {
			return errors.New("category scope must not be empty")
		}
		previous := ""
		for _, value := range selector.Values {
			current, err := category(value, "$.scope.values")
			if err != nil || current <= previous {
				return errors.New("scope categories must be unique and ascending")
			}
			previous = current
		}
	} else if selector.Type != "uncategorized" || len(selector.Values) != 0 {
		return errors.New("invalid scope selector")
	}
	if v.Status != "active" && v.Status != "revoked" {
		return errors.New("invalid grant status")
	}
	if v.IssuedAt < 0 || v.UpdatedAt < v.IssuedAt || (v.ExpiresAt != nil && *v.ExpiresAt < 0) {
		return errors.New("invalid grant timestamps")
	}
	if err := hailAddress(v.ConsentContext.GranteeAddress, "$.consent_context.grantee_address"); err != nil {
		return err
	}
	if err := preflightDigest(v.ConsentContext.AddressBindingHash); err != nil {
		return err
	}
	if err := preflightDigest(v.ConsentContext.SenderProfileHash); err != nil {
		return err
	}
	return keyID(v.KeyID, v.Grantor, "hail-identity", "$.key_id")
}

func preflightEnvelope(v *Envelope) error {
	if v.Type != EnvelopeType || v.Version != 1 {
		return errors.New("invalid envelope type or version")
	}
	if err := uuid(v.MessageID, "$.message_id"); err != nil {
		return err
	}
	if _, err := did(v.From, "$.from"); err != nil {
		return err
	}
	if _, err := did(v.To, "$.to"); err != nil {
		return err
	}
	if v.Authorization.Type == "grant" {
		if v.Authorization.ReplyTo != "" || uuid(v.Authorization.GrantID, "$.authorization.grant_id") != nil {
			return errors.New("invalid grant authorization")
		}
	} else if v.Authorization.Type == "reply" {
		if v.Authorization.GrantID != "" || v.Category != "" || uuid(v.Authorization.ReplyTo, "$.authorization.reply_to") != nil {
			return errors.New("invalid reply authorization")
		}
	} else {
		return errors.New("invalid authorization type")
	}
	if v.Category != "" {
		if _, err := category(v.Category, "$.category"); err != nil {
			return err
		}
	}
	if v.MessageType != "" && !messageTypes[v.MessageType] {
		return errors.New("invalid message type")
	}
	if v.CreatedAt < 0 || v.ExpiresAt <= v.CreatedAt || v.ExpiresAt-v.CreatedAt > 604800 {
		return errors.New("invalid envelope validity window")
	}
	if err := preflightDigest(v.Body.Digest); err != nil {
		return err
	}
	if v.Body.Size < 1 || v.Body.Size > 262144 || v.Body.MediaType != "application/hail-body+cbor" || v.Body.Profile != "spt-1" {
		return errors.New("invalid body descriptor")
	}
	if v.Body.AvailableUntil < v.CreatedAt+2592000 || v.Body.AvailableUntil < v.ExpiresAt+300 || v.Body.Access.Type != "bearer" || len(v.Body.Access.Token) != 32 || v.Body.Access.ExpiresAt < v.Body.AvailableUntil {
		return errors.New("invalid body access or availability")
	}
	if (!v.Reply.Allowed && v.Reply.Until != nil) || (v.Reply.Allowed && (v.Reply.Until == nil || *v.Reply.Until <= v.CreatedAt)) {
		return errors.New("invalid reply permission")
	}
	return nil
}

func preflightDelivery(v *DeliveryStatus) error {
	if v.Type != DeliveryStatusType || v.Version != 1 || v.Revision < 1 {
		return errors.New("invalid delivery type, version, or revision")
	}
	if err := uuid(v.MessageID, "$.message_id"); err != nil {
		return err
	}
	if err := preflightDigest(v.EnvelopeDigest); err != nil {
		return err
	}
	if _, err := did(v.From, "$.from"); err != nil {
		return err
	}
	if _, err := did(v.To, "$.to"); err != nil {
		return err
	}
	if (v.Revision == 1) != (v.State == "accepted") {
		return errors.New("invalid delivery state/revision")
	}
	needsReason := v.State == "on-hold" || v.State == "failed" || v.State == "cancelled"
	if needsReason != (v.Reason != "") {
		return errors.New("invalid delivery reason presence")
	}
	allowed := holdReasons
	if v.State == "failed" {
		allowed = failureReasons
	} else if v.State == "cancelled" {
		allowed = cancellationReasons
	}
	if needsReason && !allowed[v.Reason] {
		return errors.New("invalid delivery reason")
	}
	if v.State != "accepted" && v.State != "on-hold" && v.State != "delivered" && v.State != "failed" && v.State != "cancelled" {
		return errors.New("invalid delivery state")
	}
	if v.OccurredAt < 0 || (v.State == "on-hold" && (v.RetryAt == nil || *v.RetryAt < v.OccurredAt)) || (v.State != "on-hold" && v.RetryAt != nil) {
		return errors.New("invalid delivery timestamps")
	}
	return nil
}

func preflightBody(v *SPTBody) error {
	limits := DefaultResourceLimits()
	if v.Version != 1 || v.Profile != "spt-1" || len(v.Blocks) > limits.MaximumArrayLength {
		return errors.New("invalid body header or block count")
	}
	for _, block := range v.Blocks {
		if block.Type != "block" || block.Style != "normal" || len(block.MarkDefs) != 0 || len(block.Children) == 0 || len(block.Children) > limits.MaximumArrayLength {
			return errors.New("invalid text block")
		}
		for _, span := range block.Children {
			if span.Type != "span" || len(span.Marks) != 0 {
				return errors.New("invalid text span")
			}
		}
	}
	return nil
}

func preflightDigest(v Digest) error {
	if v.Algorithm != "sha-256" || len(v.Value) != 32 {
		return errors.New("invalid SHA-256 digest")
	}
	return nil
}

func preflightTrustedValue(value reflect.Value, limits ResourceLimits, depth int, count *int, omitEmpty bool) (uint64, error) {
	if depth > limits.MaximumDepth {
		return 0, errors.New("resource limit: payload nesting too deep")
	}
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			*count++
			if *count > limits.MaximumItems {
				return 0, errors.New("resource limit: too many payload values")
			}
			return 1, nil
		}
		return preflightTrustedValue(value.Elem(), limits, depth, count, false)
	}
	if value.Kind() == reflect.Interface {
		if value.IsNil() {
			*count++
			if *count > limits.MaximumItems {
				return 0, errors.New("resource limit: too many payload values")
			}
			return 1, nil
		}
		return preflightTrustedValue(value.Elem(), limits, depth, count, false)
	}
	*count++
	if *count > limits.MaximumItems {
		return 0, errors.New("resource limit: too many payload values")
	}
	switch value.Kind() {
	case reflect.Bool:
		return 1, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return integerSize(value.Int())
	case reflect.String:
		text := value.String()
		if !utf8.ValidString(text) {
			return 0, errors.New("invalid UTF-8 string")
		}
		if len(text) > limits.MaximumTextBytes {
			return 0, errors.New("resource limit: text string too large")
		}
		return argumentSize(uint64(len(text))) + uint64(len(text)), nil
	case reflect.Slice:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			if value.IsNil() && !omitEmpty {
				return 1, nil
			}
			length := value.Len()
			if length > limits.MaximumByteStringLength {
				return 0, errors.New("resource limit: byte string too large")
			}
			return argumentSize(uint64(length)) + uint64(length), nil
		}
		if value.Len() > limits.MaximumArrayLength {
			return 0, errors.New("resource limit: typed array too large")
		}
		total := argumentSize(uint64(value.Len()))
		for i := 0; i < value.Len(); i++ {
			size, err := preflightTrustedValue(value.Index(i), limits, depth+1, count, false)
			if err != nil {
				return 0, err
			}
			total += size
		}
		return total, nil
	case reflect.Struct:
		entries := 0
		for i := 0; i < value.NumField(); i++ {
			tag := value.Type().Field(i).Tag.Get("cbor")
			parts := strings.Split(tag, ",")
			if tag == "-" || (len(parts) > 1 && parts[1] == "omitempty" && value.Field(i).IsZero()) {
				continue
			}
			entries++
		}
		if entries > limits.MaximumMapEntries {
			return 0, errors.New("resource limit: typed map too large")
		}
		total := argumentSize(uint64(entries))
		for i := 0; i < value.NumField(); i++ {
			field := value.Type().Field(i)
			parts := strings.Split(field.Tag.Get("cbor"), ",")
			if field.Tag.Get("cbor") == "-" || (len(parts) > 1 && parts[1] == "omitempty" && value.Field(i).IsZero()) {
				continue
			}
			key := parts[0]
			keySize, err := preflightValue(key, limits, depth+1, count)
			if err != nil {
				return 0, err
			}
			fieldSize, err := preflightTrustedValue(value.Field(i), limits, depth+1, count, false)
			if err != nil {
				return 0, err
			}
			total += keySize + fieldSize
		}
		return total, nil
	default:
		return 0, fmt.Errorf("unsupported trusted payload value %s", value.Kind())
	}
}
