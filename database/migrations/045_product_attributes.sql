BEGIN;
-- 尺寸重量箱规：variant_id 为空表示商品级，非空表示该规格的覆盖值
CREATE TABLE product_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  net_weight_g integer CHECK (net_weight_g > 0),
  product_length_mm integer CHECK (product_length_mm > 0),
  product_width_mm integer CHECK (product_width_mm > 0),
  product_height_mm integer CHECK (product_height_mm > 0),
  package_weight_g integer CHECK (package_weight_g > 0),
  package_length_mm integer CHECK (package_length_mm > 0),
  package_width_mm integer CHECK (package_width_mm > 0),
  package_height_mm integer CHECK (package_height_mm > 0),
  carton_quantity integer CHECK (carton_quantity > 0),
  carton_gross_weight_g integer CHECK (carton_gross_weight_g > 0),
  carton_length_mm integer CHECK (carton_length_mm > 0),
  carton_width_mm integer CHECK (carton_width_mm > 0),
  carton_height_mm integer CHECK (carton_height_mm > 0),
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_product_measurements_product ON product_measurements(product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_product_measurements_variant ON product_measurements(variant_id) WHERE variant_id IS NOT NULL;

-- 属性字典：按分类给出推荐字段，也是录入模板；category 为空表示全部分类
CREATE TABLE product_attribute_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category varchar(120),
  label varchar(60) NOT NULL,
  group_name varchar(30) NOT NULL DEFAULT '产品特性',
  value_type text NOT NULL DEFAULT 'text' CHECK (value_type IN ('text','number','select','multi_select','boolean')),
  unit varchar(20),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  aliases text[] NOT NULL DEFAULT '{}',   -- 与平台类目字段名对应，如 {额定电压,电压}
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_attribute_defs ON product_attribute_defs(tenant_id, coalesce(category,''), lower(label));

-- 产品属性值：def_id 为空即自定义属性
CREATE TABLE product_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  def_id uuid REFERENCES product_attribute_defs(id) ON DELETE SET NULL,
  label varchar(60) NOT NULL,
  value text NOT NULL,
  unit varchar(20),
  group_name varchar(30) NOT NULL DEFAULT '产品特性',
  position integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','legacy','collected','listing','ai','import')),
  confirmed_at timestamptz,               -- 为空 = 待确认，不带入草稿，也不作为 AI 事实
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_product_attributes ON product_attributes(product_id, lower(label));
CREATE INDEX idx_product_attributes_tenant ON product_attributes(tenant_id, lower(label));

-- 回填现有规格：来自旧字段，视为已确认，保持现有行为
INSERT INTO product_attributes(tenant_id,product_id,label,value,source,confirmed_at)
SELECT p.tenant_id,p.id,left(s.key,60),s.value,'legacy',now()
FROM products p CROSS JOIN LATERAL jsonb_each_text(p.specifications) s
WHERE p.deleted_at IS NULL AND btrim(s.key)<>'' AND btrim(coalesce(s.value,''))<>''
ON CONFLICT DO NOTHING;
COMMIT;
