-- Generated pictures: upload to the shop's 1688 photo album and put the album picture into a collected product's
-- main pictures (with the replaced URL kept for undo). Remembers the album used per shop.
BEGIN;

ALTER TABLE image_assets
  ADD COLUMN photo_status text CHECK (photo_status IN ('uploading','uploaded','unknown')),
  ADD COLUMN photo_url text,
  ADD COLUMN photo_connection_id uuid REFERENCES integration_1688_connections(id) ON DELETE SET NULL,
  ADD COLUMN photo_album_id varchar(20),
  ADD COLUMN photo_uploaded_at timestamptz,
  -- {collectedProductId, index, placement, previousUrl} of the last application; NULL once undone.
  ADD COLUMN applied_to jsonb,
  ADD COLUMN applied_at timestamptz;

CREATE TABLE integration_1688_album_settings (
  connection_id uuid PRIMARY KEY REFERENCES integration_1688_connections(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  album_id varchar(20) NOT NULL CHECK (album_id ~ '^[0-9]{1,20}$'),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN image_assets.photo_url IS '上传到 1688 店铺相册后的图片地址（cbu*.alicdn.com），用于替换采集商品主图';
COMMENT ON COLUMN image_assets.photo_status IS 'unknown = 相册上传结果未确认，需人工核对相册，禁止自动重传';

COMMIT;
