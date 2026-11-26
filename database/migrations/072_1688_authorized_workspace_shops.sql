BEGIN;

-- Operator-approved shops. A merchant account belongs to a single workspace.
CREATE TABLE tenant_1688_shops (
  ali_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  authorized_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_1688_shops_workspace ON tenant_1688_shops(tenant_id);

CREATE OR REPLACE FUNCTION enforce_1688_workspace_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  workspace_owner text;
BEGIN
  SELECT ali1688_owner_id INTO workspace_owner FROM tenants WHERE id=NEW.tenant_id FOR SHARE;
  IF EXISTS(SELECT 1 FROM tenants WHERE id<>NEW.tenant_id AND ali1688_owner_id=NEW.ali_id)
    OR EXISTS(SELECT 1 FROM tenant_1688_shops WHERE tenant_id<>NEW.tenant_id AND ali_id=NEW.ali_id)
    OR ((workspace_owner IS NOT NULL OR EXISTS(SELECT 1 FROM tenant_1688_shops WHERE tenant_id=NEW.tenant_id))
      AND workspace_owner IS DISTINCT FROM NEW.ali_id
      AND NOT EXISTS(SELECT 1 FROM tenant_1688_shops WHERE tenant_id=NEW.tenant_id AND ali_id=NEW.ali_id))
  THEN
    RAISE check_violation USING CONSTRAINT = 'crm_1688_workspace_owner',
      MESSAGE = '1688 connection does not match an authorized workspace account';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
