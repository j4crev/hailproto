DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM account_grant_approvals WHERE action='restrict') THEN
    RAISE EXCEPTION 'Pending or retained category restriction approvals prevent rollback';
  END IF;
END $$;
ALTER TABLE account_grant_approvals DROP CONSTRAINT account_grant_approvals_action_check;
ALTER TABLE account_grant_approvals ADD CONSTRAINT account_grant_approvals_action_check
  CHECK (action IN ('allow','revoke'));
