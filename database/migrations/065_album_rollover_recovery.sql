BEGIN;

ALTER TABLE integration_1688_album_settings
  ADD COLUMN rollover_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN integration_1688_album_settings.rollover_pending IS
  '当前相册自动换册后，等待首次成功上传并恢复该店铺因单个相册已满而暂停的任务';

COMMIT;
