-- Image workshop: AI image edits (Qwen), e-commerce image suites (APIMart GPT-Image-2.5), inspection cache and
-- the per-tenant switch that lets the agent replace flagged product images with newly generated ones.
BEGIN;

-- One generated or uploaded picture. Bytes live in private OSS (image-workshop/<tenant>/<id>.png).
CREATE TABLE image_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collected_product_id uuid REFERENCES collected_products(id) ON DELETE CASCADE,
  batch_id uuid,
  operation text NOT NULL CHECK (operation IN ('upload','white_bg','background','resize',
    'suite_white','suite_scene','suite_detail','suite_model','suite_selling','suite_spec')),
  provider text NOT NULL CHECK (provider IN ('local','qwen','apimart')),
  model text,
  source_url text,
  reference_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Main-image position this picture is meant to replace (agent replacement of a flagged image).
  replaces_index integer CHECK (replaces_index IS NULL OR replaces_index BETWEEN 0 AND 19),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  task_id text,
  attempts integer NOT NULL DEFAULT 0,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  oss_key text UNIQUE,
  width integer,
  height integer,
  bytes integer,
  findings jsonb,
  error text,
  cost numeric(12,5),
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','agent')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_image_assets_tenant ON image_assets(tenant_id, created_at DESC);
CREATE INDEX idx_image_assets_product ON image_assets(collected_product_id, created_at DESC) WHERE collected_product_id IS NOT NULL;
CREATE INDEX idx_image_assets_work ON image_assets(next_poll_at) WHERE status IN ('pending','processing');

-- Watermark / brand-logo screening of source images, cached per URL so a picture is checked once.
CREATE TABLE image_inspections (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url text NOT NULL,
  readable boolean NOT NULL,
  watermark boolean NOT NULL,
  rights_risk boolean NOT NULL,
  reason text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, url)
);

CREATE TABLE image_workshop_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Agent: screen newly collected products and generate replacements for flagged main images (never edits the flagged picture).
  auto_replace boolean NOT NULL DEFAULT false,
  suite_model text NOT NULL DEFAULT 'gpt-image-2.5-flare' CHECK (suite_model IN ('gpt-image-2.5-flare','gpt-image-2.5-sunburst')),
  suite_quality text NOT NULL DEFAULT 'medium' CHECK (suite_quality IN ('low','medium','high','xhigh')),
  enabled_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- When the agent last screened a collected product's images (NULL = not yet).
ALTER TABLE collected_products ADD COLUMN images_screened_at timestamptz;

COMMENT ON TABLE image_assets IS 'AI 图片编辑与电商套图结果；字节存私有 OSS，不改动来源图片';
COMMENT ON COLUMN image_assets.replaces_index IS 'Agent 为被标记主图生成的替代图位置；替代图只用未标记的图片作参考';

COMMIT;
