BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM delivered_messages WHERE trashed_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM account_message_preferences WHERE NOT trash_enabled) THEN
    RAISE EXCEPTION 'Restore or purge Trash and re-enable Trash before rolling back its schema';
  END IF;
END $$;
DROP TABLE account_message_preferences;
DROP INDEX delivered_messages_trash_expiry;
ALTER TABLE delivered_messages DROP COLUMN trashed_at;
DELETE FROM schema_migrations WHERE version=76;
COMMIT;
