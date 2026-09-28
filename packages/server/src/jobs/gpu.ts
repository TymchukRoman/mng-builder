export type GpuOwner = 'comfy' | 'ollama';
/** Frees one side's VRAM. `signal` is the acquiring job's (M5): a releaser that waits should stop when it aborts. */
export type GpuReleaser = (signal?: AbortSignal) => Promise<void>;

/** Tracks who holds the GPU and frees the other side before a switch (ComfyUI /free, ollama keep_alive: 0). */
export class GpuArbiter {
  private owner: GpuOwner | null = null;
  private readonly releasers = new Map<GpuOwner, GpuReleaser>();
  private chain: Promise<void> = Promise.resolve();

  setReleaser(owner: GpuOwner, fn: GpuReleaser): void {
    this.releasers.set(owner, fn);
  }

  /**
   * Unless `owner` already holds the GPU, awaits the other side's releaser first. Serialised. That includes the first
   * acquire of this process (owner still null, M1): ComfyUI and ollama outlive a server restart, so the other side may
   * still hold VRAM; both releasers are idempotent and treat a down service as released (G2).
   */
  acquire(owner: GpuOwner, signal?: AbortSignal): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.owner !== owner) {
        const release = this.releasers.get(owner === 'comfy' ? 'ollama' : 'comfy');
        if (release) await release(signal);
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
