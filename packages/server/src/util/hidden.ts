/**
 * Spawn options that never draw a console window. Copied from cleopatra
 * (packages/gateway/src/util/hidden.ts). A console-less parent — the detached
 * server — spawning a console program makes Windows open a new console window
 * unless CREATE_NO_WINDOW (`windowsHide`) is set. Spread into every spawn.
 */
export const HIDDEN = { windowsHide: true } as const;

/** For a child that must outlive this process. On Windows `detached` alone flashes a window. */
export const HIDDEN_DETACHED = { ...HIDDEN, detached: true } as const;
