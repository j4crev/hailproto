package hailcodec

import "errors"

func connectionInvitationValue(v *ConnectionInvitation) map[any]any {
	var expiry any
	if v.ExpiresAt != nil {
		expiry = *v.ExpiresAt
	}
	return map[any]any{"type": v.Type, "version": v.Version, "invitation_id": v.InvitationID, "from": v.From,
		"token_hash": digestValue(v.TokenHash), "issued_at": v.IssuedAt, "expires_at": expiry, "key_id": v.KeyID}
}
func connectionConfirmationValue(v *ConnectionConfirmation) map[any]any {
	return map[any]any{"type": v.Type, "version": v.Version, "confirmation_id": v.ConfirmationID, "from": v.From, "to": v.To,
		"invitation_id": v.InvitationID, "invitation_hash": digestValue(v.InvitationHash), "issued_at": v.IssuedAt, "expires_at": v.ExpiresAt, "key_id": v.KeyID}
}
func connectionGrantValue(v *ConnectionGrant) map[any]any {
	var expiry, previous any
	if v.ExpiresAt != nil {
		expiry = *v.ExpiresAt
	}
	if v.Previous != nil {
		previous = v.Previous
	}
	return map[any]any{"type": v.Type, "version": v.Version, "grant_id": v.GrantID, "connection_id": v.ConnectionID, "revision": v.Revision,
		"previous": previous, "grantor": v.Grantor, "grantee": v.Grantee, "status": v.Status, "issued_at": v.IssuedAt, "updated_at": v.UpdatedAt,
		"expires_at": expiry, "key_id": v.KeyID, "consent_context": map[any]any{"grantee_address": v.ConsentContext.GranteeAddress,
			"address_binding_hash": digestValue(v.ConsentContext.AddressBindingHash), "invitation_hash": digestValue(v.ConsentContext.InvitationHash),
			"confirmation_hash": digestValue(v.ConsentContext.ConfirmationHash)}}
}
func connectionExpiry(m map[any]any, confirmation bool) error {
	issued, e := intValue(m["issued_at"], "$.issued_at", 0)
	if e != nil {
		return e
	}
	if m["expires_at"] == nil {
		if confirmation {
			return errors.New("confirmation must expire")
		}
		return nil
	}
	until, e := intValue(m["expires_at"], "$.expires_at", 0)
	if e != nil {
		return e
	}
	if until <= issued || confirmation && until-issued > 300 {
		return errors.New("invalid connection validity window")
	}
	return nil
}
func validateConnectionInvitation(m map[any]any) error {
	if e := exact(m, []string{"type", "version", "invitation_id", "from", "token_hash", "issued_at", "expires_at", "key_id"}, nil, "$"); e != nil {
		return e
	}
	if e := uuid(m["invitation_id"], "$.invitation_id"); e != nil {
		return e
	}
	owner, e := did(m["from"], "$.from")
	if e != nil {
		return e
	}
	if e = digest(m["token_hash"], "$.token_hash"); e != nil {
		return e
	}
	if e = connectionExpiry(m, false); e != nil {
		return e
	}
	return keyID(m["key_id"], owner, "hail-identity", "$.key_id")
}
func validateConnectionConfirmation(m map[any]any) error {
	if e := exact(m, []string{"type", "version", "confirmation_id", "from", "to", "invitation_id", "invitation_hash", "issued_at", "expires_at", "key_id"}, nil, "$"); e != nil {
		return e
	}
	if e := uuid(m["confirmation_id"], "$.confirmation_id"); e != nil {
		return e
	}
	if e := uuid(m["invitation_id"], "$.invitation_id"); e != nil {
		return e
	}
	actor, e := did(m["from"], "$.from")
	if e != nil {
		return e
	}
	peer, e := did(m["to"], "$.to")
	if e != nil {
		return e
	}
	if actor == peer {
		return errors.New("cannot connect to self")
	}
	if e = digest(m["invitation_hash"], "$.invitation_hash"); e != nil {
		return e
	}
	if e = connectionExpiry(m, true); e != nil {
		return e
	}
	return keyID(m["key_id"], actor, "hail-identity", "$.key_id")
}
func validateConnectionGrant(m map[any]any) error {
	if e := exact(m, []string{"type", "version", "grant_id", "connection_id", "revision", "previous", "grantor", "grantee", "status", "issued_at", "updated_at", "expires_at", "consent_context", "key_id"}, nil, "$"); e != nil {
		return e
	}
	if e := uuid(m["grant_id"], "$.grant_id"); e != nil {
		return e
	}
	if e := uuid(m["connection_id"], "$.connection_id"); e != nil {
		return e
	}
	rev, e := intValue(m["revision"], "$.revision", 1)
	if e != nil {
		return e
	}
	if rev == 1 {
		if m["previous"] != nil {
			return errors.New("initial revision has no predecessor")
		}
	} else if e = byteValue(m["previous"], 32, "$.previous"); e != nil {
		return e
	}
	owner, e := did(m["grantor"], "$.grantor")
	if e != nil {
		return e
	}
	peer, e := did(m["grantee"], "$.grantee")
	if e != nil {
		return e
	}
	if owner == peer {
		return errors.New("cannot connect to self")
	}
	if m["status"] != "active" && m["status"] != "revoked" {
		return errors.New("invalid connection grant status")
	}
	if e = connectionExpiry(m, false); e != nil {
		return e
	}
	issued, _ := intValue(m["issued_at"], "$.issued_at", 0)
	updated, e := intValue(m["updated_at"], "$.updated_at", 0)
	if e != nil {
		return e
	}
	if updated < issued {
		return errors.New("updated_at precedes issued_at")
	}
	c, e := mapValue(m["consent_context"], "$.consent_context")
	if e != nil {
		return e
	}
	if e = exact(c, []string{"grantee_address", "address_binding_hash", "invitation_hash", "confirmation_hash"}, nil, "$.consent_context"); e != nil {
		return e
	}
	if e = hailAddress(c["grantee_address"], "$.consent_context.grantee_address"); e != nil {
		return e
	}
	for _, field := range []string{"address_binding_hash", "invitation_hash", "confirmation_hash"} {
		if e = digest(c[field], "$.consent_context."+field); e != nil {
			return e
		}
	}
	return keyID(m["key_id"], owner, "hail-identity", "$.key_id")
}
