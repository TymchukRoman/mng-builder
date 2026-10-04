import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type Job, type Settings } from '@manga/shared';
import { Engines, resolveEngine, textTaskOf } from '../src/engines/resolve.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { EngineUnavailableError, InvalidOutputError, QuotaExceededError } from '../src/engines/errors.js';
import { PermanentError, TransientError } from '../src/jobs/index.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { abortError, sleep } from '../src/util/abort.js';

const withEngine = (engine: Settings['engine']): Settings => ({ ...DEFAULT_SETTINGS, engine });

describe('resolveEngine', () => {
  it('falls back to the global mode', () => {
    expect(resolveEngine(withEngine({ mode: 'claude', tasks: {} }), 'story')).toBe('claude');
    expect(resolveEngine(withEngine({ mode: 'local', tasks: {} }), 'review')).toBe('local');
  });

  it('lets a per-task override win', () => {
    const settings = withEngine({ mode: 'claude', tasks: { review: 'local' } });
    expect(resolveEngine(settings, 'review')).toBe('local');
    expect(resolveEngine(settings, 'prompts')).toBe('claude');
    expect(resolveEngine(withEngine({ mode: 'local', tasks: { story: 'claude' } }), 'story')).toBe('claude');
  });
});

describe('Engines', () => {
  it('reads the settings on every call and maps local work to the gpu lane', () => {
    const claude = new ScriptedEngine('claude', {});
    const local = new ScriptedEngine('local', {});
    let settings = withEngine({ mode: 'claude', tasks: {} });
    const engines = new Engines({ settings: () => settings, claude, local });
    expect(engines.for('prompts')).toBe(claude);
    expect(engines.laneFor('prompts')).toBe('claude');
    settings = withEngine({ mode: 'local', tasks: {} });
    expect(engines.for('prompts')).toBe(local);
    expect(engines.laneFor('prompts')).toBe('gpu');
  });

  it('forLane: the lane decides the engine, whatever the settings say (I1)', () => {
    const claude = new ScriptedEngine('claude', {});
    const local = new ScriptedEngine('local', {});
    const engines = new Engines({ settings: () => withEngine({ mode: 'local', tasks: { prompts: 'local' } }), claude, local });
    expect(engines.forLane('claude')).toBe(claude);
    expect(engines.forLane('gpu')).toBe(local);
    expect(() => engines.forLane('cpu')).toThrow(PermanentError);
    expect(() => engines.forLane('cpu')).toThrow('No text engine runs in the "cpu" lane');
  });
});

describe('textTaskOf', () => {
  const job = (kind: Job['kind'], payload: unknown): Pick<Job, 'kind' | 'payload'> => ({ kind, payload });
  it('derives the task of the text jobs M2 queues, and null for anything else', () => {
    expect(textTaskOf(job('llm.step', { type: 'panel-prompt', panelId: 'pn_x' }))).toBe('prompts');
    expect(textTaskOf(job('llm.step', { type: 'appearance', characterId: 'cr_x', description: 'd' }))).toBe('prompts');
    expect(textTaskOf(job('image.review', { imageId: 'im_x', panelId: null }))).toBe('review');
    expect(textTaskOf(job('llm.step', { type: 'episode', runId: 'er_x', step: 'render' }))).toBeNull();
    expect(textTaskOf(job('llm.step', null))).toBeNull();
    expect(textTaskOf(job('image.generate', { target: 'panel', panelId: 'pn_x' }))).toBeNull();
  });

  it('maps an episode step through STEP_TASK (F1); render, lettering and unknown steps have none', () => {
    const step = (s: string) => job('llm.step', { type: 'episode', runId: 'er_x', step: s });
    expect(textTaskOf(step('premise'))).toBe('story');
    expect(textTaskOf(step('outline'))).toBe('story');
    expect(textTaskOf(step('breakdown'))).toBe('story');
    expect(textTaskOf(step('scripts'))).toBe('dialogue');
    expect(textTaskOf(step('prompts'))).toBe('prompts');
    expect(textTaskOf(step('lettering'))).toBeNull();
    expect(textTaskOf(step('constructor'))).toBeNull();
    expect(textTaskOf(job('llm.step', { type: 'episode', runId: 'er_x' }))).toBeNull();
  });

  it('maps the chapter summary to the story task, so an engine switch re-lanes it (W1 F10)', () => {
    expect(textTaskOf(job('llm.step', { type: 'chapter-summary', chapterId: 'ch_x', runId: 'er_x' }))).toBe('story');
  });
});

describe('ScriptedEngine', () => {
  const schema = z.object({ scene: z.string() });
  const req = { name: 'panel-prompt', task: 'prompts' as const, system: 'S', prompt: 'P', schema };

  it('answers by request name and validates against the schema', async () => {
    const engine = new ScriptedEngine('claude', { 'panel-prompt': () => ({ scene: 'solo' }) });
    await expect(engine.completeJson(req)).resolves.toEqual({ scene: 'solo' });
    expect(engine.calls.map((c) => c.name)).toEqual(['panel-prompt']);
  });

  it('fails clearly without a scripted answer', async () => {
    const err = await new ScriptedEngine('local', {}).completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe('Scripted local engine has no response for "panel-prompt"');
  });

  it('rejects answers that do not match the schema', async () => {
    const engine = new ScriptedEngine('claude', { 'panel-prompt': () => ({ scene: 3 }) });
    const err = await engine.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOutputError);
    expect((err as InvalidOutputError).raw).toBe('{"scene":3}');
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new ScriptedEngine('claude', { 'panel-prompt': () => ({ scene: 'x' }) });
    await expect(engine.completeJson({ ...req, signal: controller.signal })).rejects.toThrow();
    expect(engine.calls).toHaveLength(1);
  });

  it('reports healthy', async () => {
    await expect(new ScriptedEngine('local', {}).health()).resolves.toEqual({ ok: true, detail: 'scripted local engine (fakes)' });
  });
});

describe('errors and abort helpers', () => {
  it('quota errors are transient and carry the reset time', () => {
    const err = new QuotaExceededError('2100-01-01T00:00:00.000Z');
    expect(err).toBeInstanceOf(TransientError);
    expect(err.resetsAt).toBe('2100-01-01T00:00:00.000Z');
    expect(err.message).toBe('Claude quota exhausted until 2100-01-01T00:00:00.000Z');
  });

  it('abortError prefers the signal reason and sleep stops on abort', async () => {
    const controller = new AbortController();
    const reason = new Error('stop now');
    setTimeout(() => controller.abort(reason), 10);
    await expect(sleep(5_000, controller.signal)).rejects.toBe(reason);
    expect(abortError(undefined).message).toBe('Cancelled');
  });

  it('FAKE_RESPONSES covers the M2 and M4 request names', () => {
    expect(Object.keys(FAKE_RESPONSES).sort()).toEqual([
      'appearance', 'brief.audit', 'brief.extract', 'episode.breakdown', 'episode.outline', 'episode.premise', 'episode.prompts', 'episode.scripts', 'episode.scripts-audit',
      'episode.summary', 'manga.plan', 'manga.plan-audit', 'panel-prompt', 'review',
    ]);
  });
});
