import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright';
import { defaultModules } from '../src/all-modules.js';
import { startServer } from '../src/app.js';
import { FAKE_RESPONSES } from '../src/dev/fake-responses.js';
import { createCharacter } from '../src/domain/characters.js';
import { deletePage } from '../src/domain/delete.js';
import { createFrame } from '../src/domain/frames.js';
import { chapterPages } from '../src/domain/order.js';
import { createCoverPage, createPage, NeedsConfirmError, pageDetail } from '../src/domain/pages.js';
import { randomSeed } from '../src/domain/seed.js';
import { InvalidOutputError } from '../src/engines/errors.js';
import { Engines, relaneTextJobs, textTaskOf } from '../src/engines/resolve.js';
import { ScriptedEngine } from '../src/engines/scripted.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { emitEntity, EventBus } from '../src/events/bus.js';
import { promptStyleFor, routeRecipe } from '../src/imaging/route.js';
import { GpuArbiter, JobQueue, PermanentError, TransientError } from '../src/jobs/index.js';
import { registerLlmStep } from '../src/jobs/llm-step.js';
import { aiModule } from '../src/modules/ai.js';
import { imagingModule } from '../src/modules/imaging.js';
import { servicesFor } from '../src/modules/services.js';
import { cameraSentence, cameraTags } from '../src/prompts/camera.js';
import { NotFoundError, openStore } from '../src/store/index.js';

describe('M4 preflight', () => {
  it('finds every M1/M2 function M4 consumes', () => {
    const fns = [
      startServer, defaultModules, createCharacter, deletePage, createFrame, chapterPages, createCoverPage, createPage, pageDetail,
      randomSeed, promptStyleFor, routeRecipe, registerLlmStep, aiModule, imagingModule, servicesFor, openStore,
      textTaskOf, relaneTextJobs, emitEntity, cameraTags, cameraSentence,
    ];
    for (const fn of fns) expect(typeof fn).toBe('function');
  });

  it('finds every M1/M2 class M4 consumes', () => {
    const classes = [NeedsConfirmError, Engines, ScriptedEngine, InvalidOutputError, ConflictError, ValidationError, EventBus, GpuArbiter, JobQueue, PermanentError, TransientError, NotFoundError];
    for (const cls of classes) expect(typeof cls).toBe('function');
    expect(typeof FAKE_RESPONSES).toBe('object');
    expect(typeof Engines.prototype.forLane).toBe('function');
  });

  it('has playwright with a launchable headless browser, and pdf-lib, available to the server', async () => {
    expect(typeof PDFDocument.create).toBe('function');
    const browser = await chromium.launch();
    await browser.close();
  });
});
