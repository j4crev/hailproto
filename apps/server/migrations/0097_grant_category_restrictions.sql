ALTER TABLE account_grant_approvals DROP CONSTRAINT account_grant_approvals_action_check;
ALTER TABLE account_grant_approvals ADD CONSTRAINT account_grant_approvals_action_check
  CHECK (action IN ('allow','revoke','restrict'));
