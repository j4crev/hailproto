-- Revert application consumers first. Do not silently discard issued authority
-- or consumed signup intent; explicitly export/remove it before schema rollback.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM custom_address_authorizations) THEN
    RAISE EXCEPTION 'Export and explicitly remove address authorizations before rollback';
  END IF;
END $$;
DROP TABLE custom_address_authorizations;
