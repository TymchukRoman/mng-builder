import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readingOrder, type Chapter, type Character, type Page, type PageDetail } from '@manga/shared';
import { ApiClient } from '../src/client.js';
import { makePng, startHarness, type Harness } from './helpers.js';

let h: Harness;
let api: ApiClient;
beforeAll(async () => {
  h = await startHarness();
  api = new ApiClient(h.url);
});
afterAll(async () => {
  await h.close();
});

describe('character commands', () => {
  it('add, upload and pick', async () => {
    expect((await h.run('create', 'Oni Tales', '--dir', 'ltr')).code).toBe(0);
    const aiko = await h.json<Character>('character', 'add', 'oni tales', '--name', 'Aiko', '--role', 'main', '--appearance', '1girl, red hair', '--seed', '42');
    expect(aiko).toMatchObject({ name: 'Aiko', role: 'main', appearanceTags: '1girl, red hair', seed: 42 });
    expect((await h.run('character', 'add', 'oni tales', '--name', 'Ren')).stdout).toMatch(/^created cr_[a-z2-7]{10}  Ren  \(supporting, seed \d+\)\n$/);
    const file = join(h.lib, 'aiko.png');
    writeFileSync(file, makePng(32, 48));
    const up = await h.run('character', 'upload', 'Aiko', file, '--slot', 'portrait', '--manga', 'oni tales');
    expect(up.stdout).toMatch(/^uploaded im_[a-z2-7]{10} \(32x48\) as portrait of Aiko\n$/);
    const imageId = /(im_[a-z2-7]{10})/.exec(up.stdout)?.[1] ?? '';
    expect((await h.run('character', 'pick', 'Aiko', imageId, '--slot', 'fullbody')).stdout).toBe(`Aiko fullbody = ${imageId}\n`);
    expect((await api.get<Character>(`/api/characters/${aiko.id}`)).refs).toEqual({ portrait: imageId, fullbody: imageId });
    expect((await h.run('character', 'add', 'oni tales')).code).toBe(2);
    expect((await h.run('character', 'add', 'oni tales', '--name', 'B', '--seed', '-1')).code).toBe(2);
    expect((await h.run('character', 'upload', 'Aiko', join(h.lib, 'nope.png'), '--slot', 'portrait')).code).toBe(1);
  });
});

describe('chapter commands', () => {
  it('add, list and rm', async () => {
    expect((await h.run('chapter', 'add', 'Oni Tales', 'Opening')).stdout).toMatch(/^created ch_[a-z2-7]{10}  #1  Opening\n$/);
    await h.run('chapter', 'add', 'Oni Tales', 'Second');
    const list = await h.run('chapter', 'list', 'oni tales');
    expect(list.stdout).toMatch(/^#1\s+ch_[a-z2-7]{10}\s+Opening\s+draft$/m);
    expect(list.stdout).toMatch(/^#2\s+ch_[a-z2-7]{10}\s+Second\s+draft$/m);
    expect((await h.run('chapter', 'rm', 'Oni Tales/2')).stdout).toMatch(/^deleted ch_[a-z2-7]{10}  #2  Second\n$/);
    expect((await h.json<Chapter[]>('chapter', 'list', 'oni tales')).map((c) => c.number)).toEqual([1]);
    expect((await h.run('chapter', 'rm', 'garbage')).code).toBe(2);
  });
});

describe('page commands', () => {
  it('add, layout with and without --confirm, split, merge, resize, show, rm, and layouts', async () => {
    const added = await h.json<PageDetail>('page', 'add', 'Oni Tales/1', '--layout', '2x2');
    expect(added.panels).toHaveLength(4);
    expect((await h.run('page', 'add', 'Oni Tales/1', '--layout', 'splash', '--at', '0')).stdout).toMatch(/^created pg_[a-z2-7]{10}  \(splash\)  panels: pn_[a-z2-7]{10}\n$/);
    const order = readingOrder(added.page.layout, 'ltr');

    const refused = await h.run('page', 'layout', added.page.id, 'splash');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('these panels would be removed');
    for (const id of order.slice(1)) expect(refused.stderr).toContain(id);
    expect(refused.stderr).not.toContain('error:');
    const refusedJson = await h.run('--json', 'page', 'layout', added.page.id, 'splash');
    expect(refusedJson.code).toBe(1);
    expect(JSON.parse(refusedJson.stdout)).toEqual({ error: 'needs_confirm', removedPanelIds: order.slice(1) });
    expect((await api.get<PageDetail>(`/api/pages/${added.page.id}`)).panels).toHaveLength(4);
    expect((await h.run('page', 'layout', added.page.id, 'splash', '--confirm')).stdout).toBe(`layout splash on ${added.page.id}  panels: ${order[0]}\n`);

    const only = order[0] ?? '';
    const split = await h.run('page', 'split', only, 'v');
    const newPanel = /new panel (pn_[a-z2-7]{10})/.exec(split.stdout)?.[1] ?? '';
    expect(newPanel).not.toBe('');
    expect((await h.run('page', 'merge', only, newPanel)).stdout).toBe(`merged ${newPanel} into ${only}\n`);
    expect((await h.run('page', 'split', only, 'x')).code).toBe(2);

    expect((await h.run('page', 'split', only, 'h')).code).toBe(0);
    expect((await h.run('page', 'resize', added.page.id, 'root', '0.99')).stdout).toBe(`resized root of ${added.page.id}: ratio 0.92 (clamped from 0.99)\n`);
    expect((await h.run('page', 'resize', added.page.id, 'root', '0.4')).stdout).toBe(`resized root of ${added.page.id}: ratio 0.4\n`);
    expect((await h.run('page', 'resize', added.page.id, 'aq', '0.5')).code).toBe(2);
    expect((await h.run('page', 'resize', added.page.id, 'root', '1.5')).code).toBe(2);
    expect((await h.run('page', 'resize', added.page.id, 'a', '0.5')).code).toBe(1);

    const shown = await h.run('page', 'show', added.page.id);
    expect(shown.stdout).toContain('panels (reading order)');
    expect(shown.stdout).toMatch(new RegExp(`^ {2}1 {2}${only} {2}x=`, 'm'));
    expect(shown.stdout).toMatch(/^ {2}root {2}h {2}0\.4$/m);

    const layouts = await h.run('layouts');
    expect(layouts.stdout.split('\n')[0]).toMatch(/^preset\s+panels$/);
    expect(layouts.stdout).toMatch(/^2x3\s+6$/m);

    expect((await h.run('page', 'rm', added.page.id)).stdout).toBe(`deleted ${added.page.id}\n`);
    expect((await api.get<Page[]>(`/api/chapters/${added.page.chapterId}/pages`)).map((p) => p.order)).toEqual([0]);
  });
});
