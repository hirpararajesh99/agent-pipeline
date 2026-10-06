/**
 * Cheap, deterministic ticket checks run before an AI agent is started.
 * This is deliberately conservative: only clearly incomplete tickets are
 * blocked. Risk signals are context for a human and the planning agent.
 */
export function preflightTicket(cfg, ticket, context) {
  const p = cfg.preflight;
  const title = String(ticket.title ?? '').trim();
  const description = String(ticket.description ?? '').trim();
  const blockers = [];
  if (!title) blockers.push('a short title');
  if (p.requireDescription && description.length < p.minDescriptionChars) {
    blockers.push(`a description of at least ${p.minDescriptionChars} characters explaining the requested result`);
  }

  const text = `${title}\n${description}`.toLowerCase();
  const risks = p.riskPatterns
    .filter((r) => r?.label && r?.pattern)
    .filter((r) => {
      try { return new RegExp(r.pattern, 'i').test(text); } catch { return false; }
    })
    .map((r) => r.label);

  const featurePaths = (context?.features ?? []).map((f) => f.readme);
  const lessonPaths = (context?.lessons ?? []).map((l) => l.file);
  const summary = [
    `Ticket text: ${title ? 'present' : 'missing'}; description: ${description.length} characters.`,
    `Relevant feature docs: ${featurePaths.length ? featurePaths.join(', ') : 'none matched'}.`,
    `Relevant lessons: ${lessonPaths.length ? lessonPaths.join(', ') : 'none matched'}.`,
    `Risk signals: ${risks.length ? risks.join(', ') : 'none detected'}.`,
  ].join('\n');
  return { ok: blockers.length === 0, blockers, risks, featurePaths, lessonPaths, summary };
}
