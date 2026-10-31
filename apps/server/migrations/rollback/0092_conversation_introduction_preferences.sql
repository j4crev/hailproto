-- Preserve explicit choices, especially denials. Empty-schema rollback only.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM account_conversation_preferences)
    OR EXISTS(SELECT 1 FROM connection_conversation_preferences) THEN
    RAISE EXCEPTION 'Retained conversation introduction preferences prevent rollback';
  END IF;
END $$;
DROP TABLE connection_conversation_preferences;
DROP TABLE account_conversation_preferences;
