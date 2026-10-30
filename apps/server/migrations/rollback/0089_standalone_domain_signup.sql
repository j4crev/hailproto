DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM standalone_domain_signups) THEN
    RAISE EXCEPTION 'Export and explicitly remove standalone signup evidence before rollback';
  END IF;
END $$;
DROP TABLE standalone_domain_signups;
