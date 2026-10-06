import { runShell } from '../../exec.mjs';
import { render, shellQuote } from '../../util.mjs';

/**
 * Command-template adapter for systems like TFVC or SVN. Templates are shell commands you control.
 * {file}/{files} are quoted by the pipeline, so do not wrap them in quotes. {message} is sanitised.
 */
export function commandVcs(cfg) {
  const v = cfg.vcs;
  const ws = cfg.workspace;
  const sh = async (cmd, cwd, label) => {
    const r = await runShell(cmd, { cwd });
    if (r.code !== 0) throw new Error(`${label} failed: ${r.tail.trim().slice(-400)}`);
    return r;
  };
  return {
    async prepare({ ticket }) {
      if (v.prepare) await sh(render(v.prepare, { ticket: ticket.id }), ws, 'VCS prepare');
      return { workDir: ws };
    },
    async checkIn({ ticket, workDir, files, deletedFiles = [], message }) {
      if (v.addCommand) {
        for (const f of files) {
          const r = await runShell(render(v.addCommand, { file: shellQuote(f), ticket: ticket.id }), { cwd: workDir });
          // "add" fails for files already under version control; that is expected when v.addIgnoreFailure is on
          if (r.code !== 0 && v.addIgnoreFailure === false) throw new Error(`VCS add failed: ${r.tail.trim().slice(-300)}`);
        }
      }
      const cmd = render(v.checkinCommand, { files: [...files, ...deletedFiles].map(shellQuote).join(' '), message, ticket: ticket.id });
      const r = await sh(cmd, workDir, 'VCS check-in');
      const m = v.refPattern ? new RegExp(v.refPattern, 'i').exec(r.tail) : null;
      return { ref: m ? m[1] : 'unknown' };
    },
  };
}
