-- Schema rollback only: cannot recover browser requests discarded by migration 99.
-- Pair with the old application stack; other renamed client state is not converted.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM account_browser_authorizations) THEN
    RAISE EXCEPTION 'RACR browser authorizations prevent rollback; finish or explicitly discard them first';
  END IF;
END $$;
ALTER TABLE account_browser_authorizations
  DROP CONSTRAINT account_browser_authorizations_client_id_check;
ALTER TABLE account_browser_authorizations
  ADD CONSTRAINT account_browser_authorizations_client_id_check
  CHECK (client_id = 'hailp-cli-v1');
