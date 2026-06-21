CREATE TABLE IF NOT EXISTS videos (
  id VARCHAR(32) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  original_path TEXT NOT NULL,
  proxy_path TEXT NULL,
  render_path TEXT NULL,
  duration_ms INT NOT NULL DEFAULT 0,
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  fps DOUBLE NOT NULL DEFAULT 30,
  status VARCHAR(32) NOT NULL DEFAULT 'uploaded',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS video_jobs (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  progress INT NOT NULL DEFAULT 0,
  payload_json JSON NOT NULL,
  result_json JSON NOT NULL,
  error_text TEXT NULL,
  locked_at DATETIME(3) NULL,
  locked_by VARCHAR(128) NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_jobs_pickup (status, created_at),
  INDEX idx_jobs_video (video_id),
  CONSTRAINT fk_jobs_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS silence_segments (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  start_ms INT NOT NULL,
  end_ms INT NOT NULL,
  duration_ms INT NOT NULL,
  action VARCHAR(16) NOT NULL DEFAULT 'cut',
  INDEX idx_silences_video (video_id),
  CONSTRAINT fk_silences_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  start_ms INT NOT NULL,
  end_ms INT NOT NULL,
  text TEXT NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'manual',
  INDEX idx_transcript_video (video_id),
  CONSTRAINT fk_transcript_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subtitle_cues (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  start_ms INT NOT NULL,
  end_ms INT NOT NULL,
  text TEXT NOT NULL,
  style_json JSON NOT NULL,
  INDEX idx_subtitles_video (video_id),
  CONSTRAINT fk_subtitles_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS image_assets (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  label VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  trigger_words_json JSON NOT NULL,
  position_json JSON NOT NULL,
  timing_mode VARCHAR(32) NOT NULL DEFAULT 'word_match',
  INDEX idx_assets_video (video_id),
  CONSTRAINT fk_assets_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS waveform_points (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  start_ms INT NOT NULL,
  end_ms INT NOT NULL,
  amplitude DOUBLE NOT NULL,
  INDEX idx_waveform_video (video_id, start_ms),
  CONSTRAINT fk_waveform_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_thumbnails (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  time_ms INT NOT NULL,
  file_path TEXT NOT NULL,
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  INDEX idx_thumbnails_video (video_id, time_ms),
  CONSTRAINT fk_thumbnails_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  type VARCHAR(64) NOT NULL,
  start_ms INT NOT NULL,
  end_ms INT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  payload_json JSON NOT NULL,
  INDEX idx_timeline_video (video_id),
  CONSTRAINT fk_timeline_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS renders (
  id VARCHAR(32) PRIMARY KEY,
  video_id VARCHAR(32) NOT NULL,
  job_id VARCHAR(32) NOT NULL,
  output_path TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'done',
  settings_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_renders_video (video_id),
  CONSTRAINT fk_renders_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
