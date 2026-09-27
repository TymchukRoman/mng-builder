/** A CLI-level failure, printed as "error: <message>" (unless silent). Exit code 1 = failure, 2 = usage. */
export class CliError extends Error {
  constructor(message: string, public readonly exitCode: 1 | 2 = 1, public readonly silent = false) {
    super(message);
    this.name = 'CliError';
  }
}
