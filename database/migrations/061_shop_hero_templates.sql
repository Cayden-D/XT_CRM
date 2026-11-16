BEGIN;

CREATE TABLE image_shop_hero_templates (
  connection_id uuid PRIMARY KEY REFERENCES integration_1688_connections(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('none','tuoyang-v1','custom-v1')),
  custom_key text,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'custom-v1' OR custom_key IS NOT NULL)
);

-- The existing frame identifies 拓洋. Keep it on the identifiable shop without applying it to other storefronts.
INSERT INTO image_shop_hero_templates(connection_id,mode)
SELECT c.id,'tuoyang-v1'
FROM integration_1688_connections c JOIN image_workshop_settings s ON s.tenant_id=c.tenant_id
WHERE s.hero_reference_frame AND regexp_replace(c.display_name,'[[:space:]]+','','g')
  ~ '^(义乌市?)?拓洋(日用品有限公司)?$';

COMMIT;
