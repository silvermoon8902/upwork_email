/* Errors that should stop the sweep instead of skipping one candidate.
 * Replaces the old `String(e).includes('rate-limited')` substring matching. */
export class PauseRun extends Error {
  constructor(message) { super(message); this.name = 'PauseRun'; }
}
export const shouldPause = e => e instanceof PauseRun;
