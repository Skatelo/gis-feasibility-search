// Scheduled queue sweeper (see netlify.toml): recovers interrupted workers,
// expires jobs that were never picked up, and dispatches the live queue. The
// logic lives in lib/report-background-sweeper.js where it is unit-tested.
export { handler } from './lib/report-background-sweeper.js';
