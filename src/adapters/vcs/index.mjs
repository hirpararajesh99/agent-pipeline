import { noneVcs } from './none.mjs';
import { gitVcs } from './git.mjs';
import { commandVcs } from './command.mjs';

/** VCS contract: prepare({ticket}) -> {workDir, branch?}; checkIn({ticket, workDir, files, message, branch}) -> {ref}. */
export function createVcs(cfg) {
  if (cfg.vcs.type === 'git') return gitVcs(cfg);
  if (cfg.vcs.type === 'command') return commandVcs(cfg);
  return noneVcs(cfg);
}
