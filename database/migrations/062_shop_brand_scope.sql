BEGIN;

ALTER TABLE integration_1688_connections ADD UNIQUE (tenant_id,id);
ALTER TABLE brands ADD COLUMN connection_id uuid;
ALTER TABLE brands ADD FOREIGN KEY (tenant_id,connection_id)
  REFERENCES integration_1688_connections(tenant_id,id) ON DELETE CASCADE;

DROP INDEX uq_brands_name;
DROP INDEX uq_brands_default;
CREATE UNIQUE INDEX uq_brands_name ON brands(tenant_id,lower(btrim(name))) WHERE connection_id IS NULL;
CREATE UNIQUE INDEX uq_brands_default ON brands(tenant_id) WHERE connection_id IS NULL AND is_default;
CREATE UNIQUE INDEX uq_shop_brands_name ON brands(connection_id,lower(btrim(name)));
CREATE UNIQUE INDEX uq_shop_brands_default ON brands(connection_id) WHERE is_default;

ALTER TABLE image_inspections DROP CONSTRAINT image_inspections_pkey;
ALTER TABLE image_inspections ADD COLUMN brand_policy text NOT NULL DEFAULT '';
ALTER TABLE image_inspections ADD PRIMARY KEY (tenant_id,url,brand_policy);

COMMIT;
