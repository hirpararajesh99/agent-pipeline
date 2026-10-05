import { fileTracker } from './file.mjs';
import { clickupTracker } from './clickup.mjs';

/** Tracker contract: list(statusKeys[]), get(id), setStatus(id, statusKey), comment(id, text). Add Jira/GitHub/Linear here. */
export function createTracker(cfg) {
  if (cfg.tracker.type === 'clickup') return clickupTracker(cfg);
  return fileTracker(cfg);
}
