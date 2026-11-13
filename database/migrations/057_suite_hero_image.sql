-- 1688 首图: the eye-catching first main picture of a wholesale listing (core terms in large type, brand logo top-left).
BEGIN;
ALTER TABLE image_assets DROP CONSTRAINT IF EXISTS image_assets_operation_check;
ALTER TABLE image_assets ADD CONSTRAINT image_assets_operation_check CHECK (operation IN ('upload','white_bg','background','resize',
  'suite_hero','suite_white','suite_scene','suite_detail','suite_model','suite_selling','suite_spec','detail_poster','detail_advantages','detail_features'));
COMMIT;
