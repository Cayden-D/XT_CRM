BEGIN;
ALTER TABLE image_workshop_settings ADD COLUMN hero_reference_frame boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN image_workshop_settings.hero_reference_frame IS '启用拓洋参考图边框及固定文案，仅应用于新生成的 1688 首图';
COMMIT;
