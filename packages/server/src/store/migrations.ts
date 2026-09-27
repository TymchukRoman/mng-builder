export interface Migration { version: number; sql: string }

/** Append-only. Never edit a shipped migration; add the next number. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE mangas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  language TEXT NOT NULL,
  color_mode TEXT NOT NULL,
  reading_direction TEXT NOT NULL,
  page_format TEXT NOT NULL,
  style_guide TEXT NOT NULL,
  cover_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  personality TEXT NOT NULL,
  speech_style TEXT NOT NULL,
  appearance_tags TEXT NOT NULL,
  seed INTEGER NOT NULL,
  recipe TEXT,
  refs TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_characters_manga ON characters(manga_id);
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  cover_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  ord INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chapters_manga ON chapters(manga_id);
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ord INTEGER NOT NULL,
  layout TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pages_chapter ON pages(chapter_id);
CREATE INDEX idx_pages_manga ON pages(manga_id);
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  role TEXT,
  path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source TEXT NOT NULL,
  parent_image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  gen TEXT,
  review TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_images_owner ON images(owner_type, owner_id);
CREATE INDEX idx_images_manga ON images(manga_id);
CREATE TABLE panels (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  script TEXT NOT NULL,
  prompt TEXT NOT NULL,
  recipe TEXT,
  seed_lock INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  ref_character_ids TEXT NOT NULL,
  active_image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  image_transform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_panels_page ON panels(page_id);
CREATE TABLE text_frames (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  panel_id TEXT REFERENCES panels(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  box TEXT NOT NULL,
  tail TEXT,
  rotation REAL NOT NULL,
  font TEXT NOT NULL,
  font_size REAL NOT NULL,
  auto_fit INTEGER NOT NULL,
  align TEXT NOT NULL,
  ord INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_frames_page ON text_frames(page_id);
CREATE TABLE episode_runs (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  mode TEXT NOT NULL,
  steps TEXT NOT NULL,
  current_step INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_episodes_chapter ON episode_runs(chapter_id);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  payload TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  progress TEXT,
  episode_run_id TEXT REFERENCES episode_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_claim ON jobs(lane, status, next_run_at);
CREATE INDEX idx_jobs_created ON jobs(created_at);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
