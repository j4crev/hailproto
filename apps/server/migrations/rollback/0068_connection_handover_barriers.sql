BEGIN;
LOCK TABLE connection_handover_barriers IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>68) OR EXISTS(SELECT 1 FROM connection_handover_barriers) THEN
    RAISE EXCEPTION 'Retained connection handover barriers prevent schema rollback';
  END IF;
END $$;
DROP TRIGGER connection_handover_before_fence ON provider_migration_fences;
DROP TRIGGER connection_handover_before_generation ON account_serving_generations;
DROP TRIGGER connection_handover_before_custody ON custody_transition_preparations;
DROP FUNCTION hail_finish_peer_handover_before_cutover();
DROP TRIGGER connection_native_handover_activation ON account_connections;
DROP TRIGGER connection_federated_handover_activation ON federated_connection_pairs;
DROP FUNCTION hail_guard_connection_handover_activation();
DROP TRIGGER connection_handover_final_delivery ON delivered_messages;
DROP FUNCTION hail_guard_handover_delivery();
DROP FUNCTION hail_connection_message_allowed(text,text,uuid,bigint,boolean);
ALTER FUNCTION hail_connection_message_permission(text,text,uuid,bigint,boolean) RENAME TO hail_connection_message_allowed;
DROP FUNCTION hail_connection_handover_blocked(text,text);
DROP TABLE connection_handover_barriers;
DROP FUNCTION hail_preserve_connection_handover_barrier();
DELETE FROM schema_migrations WHERE version=68;
COMMIT;
