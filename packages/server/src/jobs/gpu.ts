export type GpuOwner = 'comfy' | 'ollama';

/** Tracks who holds the GPU and frees the other side before a switch (ComfyUI /free, ollama keep_alive: 0). */
export class GpuArbiter {
  private owner: GpuOwner | null = null;
  private readonly releasers = new Map<GpuOwner, () => Promise<void>>();
  private chain: Promise<void> = Promise.resolve();

  setReleaser(owner: GpuOwner, fn: () => Promise<void>): void {
    this.releasers.set(owner, fn);
  }

  /** If another owner holds the GPU, awaits its releaser first. Serialised. */
  acquire(owner: GpuOwner): Promise<void> {
    const run = async (): Promise<void> => {
      const previous = this.owner;
      if (previous !== null && previous !== owner) {
        const release = this.releasers.get(previous);
        if (release) await release();
      }
      this.owner = owner;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  get current(): GpuOwner | null {
    return this.owner;
  }
}
