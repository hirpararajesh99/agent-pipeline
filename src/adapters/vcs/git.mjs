import fs from 'node:fs';
import path from 'node:path';
import { runCommand, runShell } from '../../exec.mjs';
import { ensureDir, render, sanitizeText } from '../../util.mjs';

async function git(args, cwd) {
  const r = await runCommand('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.tail.trim().slice(-400)}`);
  return r;
}

/** Git adapter. Default mode "worktree": one isolated worktree + branch per ticket. */
export function gitVcs(cfg) {
  const v = cfg.vcs;
  const ws = cfg.workspace;
  const branchFor = (id) => `${v.branchPrefix}${id}`;
  return {
    async prepare({ ticket }) {
      await git(['fetch', 'origin'], ws);
      const branch = branchFor(ticket.id);
      if (v.mode === 'inplace') {
        await git(['checkout', '-B', branch, `origin/${v.baseBranch}`], ws);
        return { workDir: ws, branch };
      }
      const dir = path.join(v.worktreeRoot, ticket.id);
      if (!fs.existsSync(dir)) {
        ensureDir(v.worktreeRoot);
        const exists = (await runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: ws })).code === 0;
        await git(exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, `origin/${v.baseBranch}`], ws);
      } else {
        const m = await runCommand('git', ['merge', '--no-edit', `origin/${v.baseBranch}`], { cwd: dir });
        if (m.code !== 0) {
          await runCommand('git', ['merge', '--abort'], { cwd: dir });
          throw new Error(`Base branch no longer merges cleanly into ${branch}; a developer must resolve it.`);
        }
      }
      return { workDir: dir, branch };
    },
    async checkIn({ ticket, workDir, files, message, branch }) {
      await git(['add', '--', ...files], workDir);
      const staged = await runCommand('git', ['diff', '--cached', '--quiet'], { cwd: workDir });
      if (staged.code === 0) throw new Error('Nothing to check in: the listed files have no changes.');
      await git(['commit', '-m', message], workDir);
      const sha = (await git(['rev-parse', 'HEAD'], workDir)).tail.trim();
      if (v.push) await git(['push', '-u', 'origin', branch ?? branchFor(ticket.id)], workDir);
      if (v.prCommand) {
        const cmd = render(v.prCommand, { branch: branch ?? branchFor(ticket.id), ticket: ticket.id, title: sanitizeText(ticket.title) });
        const r = await runShell(cmd, { cwd: workDir });
        if (r.code !== 0) throw new Error(`PR command failed: ${r.tail.trim().slice(-300)}`);
      }
      return { ref: sha, branch };
    },
  };
}
