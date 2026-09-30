import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema, type Settings, type SettingsPatch } from '@manga/shared';
import { StoreCorruptError } from '../errors.js';
import type { Db } from './db.js';
import type { SettingsRepo } from './types.js';

/** Section by section; `engine.tasks` is replaced whole; the result is validated. */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    engine: { mode: patch.engine?.mode ?? base.engine.mode, tasks: patch.engine?.tasks ?? base.engine.tasks },
    claude: { models: { ...base.claude.models, ...patch.claude?.models } },
    ollama: { ...base.ollama, ...patch.ollama },
    review: { ...base.review, ...patch.review },
    routing: { ...base.routing, ...patch.routing },
    episode: { ...base.episode, ...patch.episode },
  });
}

/** The whole settings object lives under key 'app', read back leniently over the defaults so new sections get defaults. */
export class SqliteSettingsRepo implements SettingsRepo {
  constructor(private readonly db: Db) {}

  get(): Settings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as { value: string } | undefined;
    if (row === undefined) return structuredClone(DEFAULT_SETTINGS);
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      throw new StoreCorruptError('settings', 'app', 'not valid JSON');
    }
    const stored = SettingsPatchSchema.safeParse(raw);
    if (!stored.success) throw new StoreCorruptError('settings', 'app', stored.error.message);
    return mergeSettings(DEFAULT_SETTINGS, stored.data);
  }

  patch(p: SettingsPatch): Settings {
    const next = mergeSettings(this.get(), p);
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }
}
