BEGIN;

ALTER TABLE image_workshop_settings
  ADD COLUMN suite_resolution text NOT NULL DEFAULT '1k'
    CHECK (suite_resolution IN ('1k', '2k'));

COMMIT;
