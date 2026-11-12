-- Detail pictures generated for automatic listing (主海报 / 产品优势 / 产品特点), next to the main-picture suite types.
BEGIN;
ALTER TABLE image_assets DROP CONSTRAINT IF EXISTS image_assets_operation_check;
ALTER TABLE image_assets ADD CONSTRAINT image_assets_operation_check CHECK (operation IN ('upload','white_bg','background','resize',
  'suite_white','suite_scene','suite_detail','suite_model','suite_selling','suite_spec','detail_poster','detail_advantages','detail_features'));
COMMIT;
