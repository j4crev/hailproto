DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM address_binding_withdrawals) OR EXISTS (SELECT 1 FROM address_bindings WHERE expires_at IS NULL) THEN
  RAISE EXCEPTION 'Cannot restore expiring bindings after v2 publication; retain signed evidence';
 END IF;
END $$;
ALTER TABLE address_bindings ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE address_bindings ADD CONSTRAINT address_bindings_lifetime CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '90 days');

DROP TABLE address_binding_withdrawals;
