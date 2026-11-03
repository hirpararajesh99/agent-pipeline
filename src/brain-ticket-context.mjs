import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { brainFreshness } from './brain.mjs';
import { brainReview } from './brain-review.mjs';
import { tokens } from './docs.mjs';
import { redact, safeProjectPath } from './util.mjs';

// The default run is explicit: never silently choose a different analysis revision.
export function ticketBrainContext(cfg, root, { title, description, comments = [], paths = [] }) {
  const result = { findings: [], decisions: [], conflicts: [], gaps: [] };
  const words = new Set(tokens([title, description, ...comments, ...paths].join(' ')));
  const score = (s) => tokens(s).filter((word) => words.has(word)).length;
  const secrets = [process.env[cfg.tracker.tokenEnv]].filter(Boolean);
  const clean = (s) => redact(String(s), secrets);
  const run = safeProjectPath(cfg.workspace, '.project-brain/runs/default/state.json');
  if (fs.existsSync(run)) {
    const report = brainFreshness(cfg);
    let stale = 0;
    for (const finding of report.findings) {
      let current = finding.freshness === 'current';
      if (current && path.resolve(root) !== path.resolve(cfg.workspace)) {
        current = finding.evidence.every((e) => {
          try { const f = safeProjectPath(root, e.path); return fs.statSync(f).isFile() && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === e.expectedHash; } catch { return false; }
        });
      }
      if (!current) { stale++; continue; }
      const relevance = score(`${finding.statement} ${finding.evidence.map((e) => e.path).join(' ')}`);
      if (!relevance) continue;
      result.findings.push({ id: finding.id, statement: clean(finding.statement), certainty: finding.certainty,
        evidence: finding.evidence.map((e) => ({ path: clean(e.path), startLine: e.startLine, endLine: e.endLine })), score: relevance });
    }
    if (stale) result.gaps.push(`${stale} stale or unchecked Brain finding(s) excluded; refresh or review their evidence.`);
  } else result.gaps.push('No default Project Brain analysis is available for ticket context.');
  const review = brainReview(cfg);
  const relevantPaths = [...paths, ...result.findings.flatMap((finding) => finding.evidence.map((e) => e.path))]
    .map((value) => String(value).replace(/\\/g, '/'));
  let excludedScopes = 0;
  for (const decision of review.decisions.filter((d) => d.status === 'active')) {
    // Pinned references may have changed since the decision; require explicit review for now.
    if (decision.references.length) { result.gaps.push(`Decision ${decision.id} has pinned references and was excluded pending reference validation.`); continue; }
    const relevance = score(`${decision.statement} ${decision.reason} ${decision.scope}`);
    if (!relevance && decision.scope !== '.') continue;
    if (decision.scope !== '.' && !relevantPaths.some((item) => item === decision.scope || item.startsWith(`${decision.scope}/`) || decision.scope.startsWith(`${item}/`))) { excludedScopes++; continue; }
    result.decisions.push({ id: decision.id, statement: clean(decision.statement), reason: clean(decision.reason), scope: clean(decision.scope), by: clean(decision.by), score: relevance || 1 });
  }
  if (excludedScopes) result.gaps.push(`${excludedScopes} matching scoped decision(s) excluded because their scope could not be matched to selected evidence or planned files.`);
  for (const conflict of review.conflicts.filter((item) => item.status === 'open')) {
    const relevance = score(`${conflict.summary} ${conflict.left} ${conflict.right} ${conflict.scope}`);
    result.conflicts.push({ id: conflict.id, summary: clean(conflict.summary), left: clean(conflict.left),
      right: clean(conflict.right), scope: clean(conflict.scope), owner: clean(conflict.owner), score: relevance });
  }
  if (review.openConflicts.length) result.gaps.push(`Project Brain has ${review.openConflicts.length} unresolved conflict(s); review their scope and both positions before relying on related knowledge. Conflict details may be omitted by the context budget.`);
  return result;
}
