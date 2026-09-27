import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chapter, Character, Job, Manga, PageDetail, Panel, TextFrame } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { makePng, startHarness, type Harness } from './helpers.js';

let h: Harness;
let api: ApiClient;
let aiko: Character;
let ren: Character;
let detail: PageDetail;

beforeAll(async () => {
  h = await startHarness();
  api = new ApiClient(h.url);
  const manga = await api.post<Manga>('/api/mangas', { title: 'Oni Tales', readingDirection: 'ltr' });
  aiko = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Aiko' });
  ren = await api.post<Character>(`/api/mangas/${manga.id}/characters`, { name: 'Ren' });
  const chapter = await api.post<Chapter>(`/api/mangas/${manga.id}/chapters`, { title: 'One' });
  detail = await api.post<PageDetail>(`/api/chapters/${chapter.id}/pages`, { layoutPreset: 'splash' });
});
afterAll(async () => {
  await h.close();
});

const panelId = (): string => detail.panels[0]?.id ?? '';

describe('panel commands', () => {
  it('script shows the script and edits action, shot, cast and dialogue', async () => {
    expect((await h.run('panel', 'script', panelId())).stdout).toMatch(/^shot\s+medium$/m);
    const updated = await h.json<Panel>(
      'panel', 'script', panelId(), '--action', 'Aiko bows', '--shot', 'close', '--chars', 'Aiko,ren',
      '--line', 'Aiko:speech:Welcome!', '--line', '-:narration:Dawn: the market opens.',
    );
    expect(updated.script).toMatchObject({
      action: 'Aiko bows',
      shot: 'close',
      characters: [{ characterId: aiko.id, position: 'left' }, { characterId: ren.id, position: 'right' }],
      dialogue: [
        { speakerId: aiko.id, kind: 'speech', text: 'Welcome!' },
        { speakerId: null, kind: 'narration', text: 'Dawn: the market opens.' },
      ],
    });
    expect((await h.run('panel', 'script', panelId())).stdout).toContain(`  speech ${aiko.id}: Welcome!`);
    expect((await h.run('panel', 'script', panelId(), '--line', 'Aiko:yell:hi')).code).toBe(2);
    expect((await h.run('panel', 'script', panelId(), '--shot', 'sideways')).code).toBe(1);
    expect((await h.run('panel', 'script', panelId(), '--chars', 'Nobody')).code).toBe(1);
  });

  it('upload, variants and pick', async () => {
    const a = join(h.lib, 'a.png');
    const b = join(h.lib, 'b.png');
    writeFileSync(a, makePng(10, 20));
    writeFileSync(b, makePng(30, 40));
    const upA = await h.run('panel', 'upload', panelId(), a);
    expect(upA.stdout).toMatch(new RegExp(`^uploaded im_[a-z2-7]{10} \\(10x20\\), now active on ${panelId()}\\n$`));
    const first = /(im_[a-z2-7]{10})/.exec(upA.stdout)?.[1] ?? '';
    const second = /(im_[a-z2-7]{10})/.exec((await h.run('panel', 'upload', panelId(), b)).stdout)?.[1] ?? '';
    const variants = await h.run('panel', 'variants', panelId());
    expect(variants.stdout).toMatch(new RegExp(`^\\*\\s+${second}\\s+uploaded\\s+30x40`, 'm'));
    expect(variants.stdout).toMatch(new RegExp(`^\\s+${first}\\s+uploaded\\s+10x20`, 'm'));
    expect((await h.run('panel', 'pick', panelId(), first)).stdout).toBe(`active image of ${panelId()}: ${first}\n`);
    expect((await api.get<Panel>(`/api/panels/${panelId()}`)).activeImageId).toBe(first);
    expect((await h.run('panel', 'pick', panelId(), 'im_missing000')).code).toBe(1);
  });
});

describe('text commands', () => {
  it('add, edit and rm', async () => {
    const frame = await h.json<TextFrame>('text', 'add', detail.page.id, '--kind', 'speech', '--text', 'Hello', '--speaker', 'Aiko', '--panel', panelId());
    expect(frame).toMatchObject({ kind: 'speech', text: 'Hello', speakerId: aiko.id, panelId: panelId(), font: 'Shantell Sans', fontSize: 9 });
    const edited = await h.json<TextFrame>('text', 'edit', frame.id, '--text', 'Hi!', '--box', '0.1,0.1,0.4,0.15', '--speaker', '-', '--size', '10');
    expect(edited).toMatchObject({ text: 'Hi!', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.15 }, speakerId: null, fontSize: 10 });
    expect((await h.run('text', 'edit', frame.id, '--speaker', 'ren')).stdout).toBe(`updated ${frame.id}  speech  "Hi!"\n`);
    expect((await h.run('text', 'edit', frame.id)).code).toBe(2);
    expect((await h.run('text', 'edit', frame.id, '--box', '1,2')).code).toBe(2);
    expect((await h.run('text', 'add', detail.page.id, '--kind', 'title', '--text', 'ONI')).code).toBe(1);
    expect((await h.run('text', 'add', detail.page.id)).code).toBe(2);
    expect((await h.run('text', 'rm', frame.id)).stdout).toBe(`deleted ${frame.id}\n`);
    expect((await h.run('text', 'rm', frame.id)).code).toBe(1);
  });
});

describe('job commands', () => {
  it('jobs lists, --watch streams until interrupted, and cancel stops a running job', async () => {
    const queue = h.server.deps.queue;
    queue.register('export.render', (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve(null));
    }));
    expect((await h.run('jobs')).stdout).toBe('no jobs\n');
    const job = queue.enqueue({ kind: 'export.render', lane: 'cpu', payload: {} });
    await vi.waitFor(() => expect(h.server.deps.store.jobs.require(job.id).status).toBe('running'));
    expect((await h.run('jobs')).stdout).toMatch(new RegExp(`^${job.id}\\s+export\\.render\\s+cpu\\s+running`, 'm'));
    expect((await h.json<Job[]>('jobs', '--status', 'running')).map((j) => j.id)).toEqual([job.id]);
    expect((await h.run('jobs', '--status', 'stuck')).code).toBe(2);

    const ac = new AbortController();
    const watch = h.start(['jobs', '--watch'], ac.signal);
    await vi.waitFor(() => expect(watch.output()).toContain(job.id));
    expect((await h.run('cancel', job.id)).stdout).toBe(`${job.id}  cancelled\n`);
    await vi.waitFor(() => expect(watch.output()).toMatch(new RegExp(`^${job.id}\\s+export\\.render\\s+cpu\\s+cancelled`, 'm')));
    ac.abort();
    expect((await watch.result).code).toBe(0);
    expect((await h.run('cancel', 'jb_missing000')).code).toBe(1);
  });

  it('jobs --limit 0 is a usage error', async () => {
    expect((await h.run('jobs', '--limit', '0')).code).toBe(2);
  });
});
