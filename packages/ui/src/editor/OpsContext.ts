import { createContext } from 'react';
import type { Ops } from './ops';

/** Provided by the chapter editor; PageView uses it to build commands. */
export const OpsContext = createContext<Ops | null>(null);
