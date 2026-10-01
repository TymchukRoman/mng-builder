import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { cacheLookup, keysForEntity, qk } from '../src/queryKeys';
import { makeDetail, makeFrame } from './fixtures';

const none = { pageOfPanel: () => null, pageOfFrame: () => null };

describe('keysForEntity', () => {
  it('maps manga and chapter events', () => {
    expect(keysForEntity({ type: 'entity', entity: 'manga', id: 'mg_1', op: 'updated', mangaId: 'mg_1' }, none)).toEqual([['mangas'], ['manga', 'mg_1']]);
    expect(keysForEntity({ type: 'entity', entity: 'chapter', id: 'ch_1', op: 'created', mangaId: 'mg_1' }, none)).toEqual([['chapters', 'mg_1'], ['chapter', 'ch_1'], ['pages', 'ch_1']]);
  });
  it('falls back to prefixes when the owner is unknown', () => {
    expect(keysForEntity({ type: 'entity', entity: 'character', id: 'cr_1', op: 'updated', mangaId: null }, none)).toEqual([['characters'], ['character', 'cr_1'], ['characterImages', 'cr_1']]);
    expect(keysForEntity({ type: 'entity', entity: 'panel', id: 'pn_x', op: 'created', mangaId: 'mg_1' }, none)).toEqual([['page'], ['panelImages', 'pn_x'], ['missingPanels']]);
    expect(keysForEntity({ type: 'entity', entity: 'textFrame', id: 'tf_x', op: 'created', mangaId: 'mg_1' }, none)).toEqual([['page']]);
  });
  it('targets the page that owns a panel or frame', () => {
    const lookup = { pageOfPanel: (id: string) => (id === 'pn_a' ? 'pg_7' : null), pageOfFrame: (id: string) => (id === 'tf_1' ? 'pg_8' : null) };
    expect(keysForEntity({ type: 'entity', entity: 'panel', id: 'pn_a', op: 'updated', mangaId: 'mg_1' }, lookup)).toEqual([['page', 'pg_7'], ['panelImages', 'pn_a'], ['missingPanels']]);
    expect(keysForEntity({ type: 'entity', entity: 'textFrame', id: 'tf_1', op: 'updated', mangaId: 'mg_1' }, lookup)).toEqual([['page', 'pg_8']]);
  });
  it('maps images, settings and pages', () => {
    expect(keysForEntity({ type: 'entity', entity: 'image', id: 'im_1', op: 'created', mangaId: 'mg_1' }, none)).toEqual([['panelImages'], ['characterImages']]);
    expect(keysForEntity({ type: 'entity', entity: 'settings', id: 'settings', op: 'updated', mangaId: null }, none)).toEqual([['settings'], ['status']]);
    expect(keysForEntity({ type: 'entity', entity: 'page', id: 'pg_1', op: 'deleted', mangaId: 'mg_1' }, none)).toEqual([['page', 'pg_1'], ['pages'], ['missingPanels']]);
    expect(qk.missingPanels('ch_1')).toEqual(['missingPanels', 'ch_1']);
  });
});

describe('cacheLookup', () => {
  it('finds owners among cached page details', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.page('pg_1'), makeDetail('pg_1', [makeFrame('tf_1')]));
    const lookup = cacheLookup(qc);
    expect(lookup.pageOfPanel('pn_b')).toBe('pg_1');
    expect(lookup.pageOfFrame('tf_1')).toBe('pg_1');
    expect(lookup.pageOfPanel('pn_zzz')).toBeNull();
  });
});
