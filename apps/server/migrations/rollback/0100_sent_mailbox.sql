BEGIN;
-- Do not resurrect previously deleted/trashed mailbox entries on rollback.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM account_sent_dispositions) THEN
    RAISE EXCEPTION 'Restore or explicitly export and reconcile Sent disposition before rollback';
  END IF;
END $$;
DROP FUNCTION hail_sent_visible(uuid,uuid);
DROP VIEW account_sent_items;
DROP VIEW account_sent_members;
DROP TABLE account_sent_dispositions;
DELETE FROM schema_migrations WHERE version=100;
COMMIT;
