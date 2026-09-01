DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qingyu_relay_app') THEN
    CREATE ROLE qingyu_relay_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
  END IF;
END $$;

DO $$ DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'relay_devices','relay_refresh_tokens','relay_pair_tickets','cached_sessions',
    'cached_messages','cached_resources','relay_commands','relay_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid) WITH CHECK (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid)',
      table_name || '_space_policy', table_name
    );
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO qingyu_relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qingyu_relay_app;
