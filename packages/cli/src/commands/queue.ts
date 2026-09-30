import { InvalidArgumentError, type Command } from 'commander';
import type { QueueLanes } from '@manga/shared';
import type { CliContext } from '../context.js';

function gpuOnly(value: string): 'gpu' {
  if (value !== 'gpu') throw new InvalidArgumentError('only the gpu lane can be paused or resumed by hand');
  return 'gpu';
}

const describe = (lanes: QueueLanes): string =>
  lanes.pausedLanes.length === 0 ? 'no lane is paused' : lanes.pausedLanes.map((p) => `${p.lane} paused: ${p.reason}`).join('\n');

/** W1 R2: `manga queue pause|resume gpu`. A manual pause is never lifted automatically. */
export function registerQueueCommands(program: Command, ctx: () => Promise<CliContext>): void {
  const queue = program.command('queue').description('pause or resume the image queue');
  for (const action of ['pause', 'resume'] as const) {
    queue.command(action)
      .description(action === 'pause' ? 'pause the image queue until you resume it' : 'resume the image queue')
      .argument('<lane>', 'gpu', gpuOnly)
      .action(async (lane: 'gpu') => {
        const c = await ctx();
        const lanes = await c.api.post<QueueLanes>(`/api/queue/${lane}/${action}`);
        c.out(lanes, () => describe(lanes));
      });
  }
}
