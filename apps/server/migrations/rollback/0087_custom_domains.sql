-- Roll back application consumers first. Preserve registered domains and pending
-- challenges; refuse destructive rollback once any registrations exist.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM account_custom_domains) THEN
    RAISE EXCEPTION 'Export and explicitly remove custom domain registrations before rollback';
  END IF;
END $$;
DROP TABLE account_custom_domains;
