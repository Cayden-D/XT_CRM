BEGIN;

-- A claimed workspace can hold product and performance grants for only its authorized 1688 account.
-- Existing data is retained. Historical workspaces are checked before the application grants access to them.
ALTER TABLE tenants ADD COLUMN ali1688_owner_id text UNIQUE;

CREATE FUNCTION enforce_1688_workspace_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  workspace_owner text;
BEGIN
  -- Serialize new shop attachments with the first claim of a historical workspace.
  SELECT ali1688_owner_id INTO workspace_owner FROM tenants WHERE id=NEW.tenant_id FOR SHARE;
  IF workspace_owner IS NOT NULL AND workspace_owner <> NEW.ali_id THEN
    RAISE check_violation USING CONSTRAINT = 'crm_1688_workspace_owner',
      MESSAGE = '1688 connection does not match the workspace owner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_1688_product_workspace_owner
  BEFORE INSERT OR UPDATE OF tenant_id,ali_id ON integration_1688_connections
  FOR EACH ROW EXECUTE FUNCTION enforce_1688_workspace_owner();

CREATE TRIGGER check_1688_performance_workspace_owner
  BEFORE INSERT OR UPDATE OF tenant_id,ali_id ON integration_1688_perf_connections
  FOR EACH ROW EXECUTE FUNCTION enforce_1688_workspace_owner();

COMMIT;
