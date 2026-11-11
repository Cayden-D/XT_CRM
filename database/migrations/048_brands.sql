-- The shop's own brands: name and logo. The default brand is used by image suites, agent replacements and the listing's
-- brand attribute. Logos live in private OSS next to the other pictures (image-workshop/<tenant>/<id>.png).
BEGIN;
CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  -- Other spellings of the name that can appear in the logo, e.g. the English name.
  aliases text[] NOT NULL DEFAULT '{}',
  logo_key text UNIQUE,
  logo_width integer,
  logo_height integer,
  is_default boolean NOT NULL DEFAULT false,
  -- Who stated that the shop owns or may use this brand: a registered brand stops being screened as someone else's logo.
  rights_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  rights_confirmed_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_brands_name ON brands(tenant_id, lower(btrim(name)));
CREATE UNIQUE INDEX uq_brands_default ON brands(tenant_id) WHERE is_default;
COMMIT;
