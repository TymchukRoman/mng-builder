import { PermanentError, TransientError } from '../jobs/index.js';

/** The engine cannot run at all (binary missing, not logged in, ollama down, model not pulled). Never retried. */
export class EngineUnavailableError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/** The model's answer did not match the schema even after the correction round. `raw` keeps the last answer. */
export class InvalidOutputError extends PermanentError {
  constructor(message: string, public raw: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

/** Claude reported an exhausted quota window. Retried after the claude lane resumes. */
export class QuotaExceededError extends TransientError {
  constructor(public resetsAt: string | null) {
    super(resetsAt ? `Claude quota exhausted until ${resetsAt}` : 'Claude quota exhausted');
    this.name = 'QuotaExceededError';
  }
}
