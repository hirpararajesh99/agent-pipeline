import fs from 'node:fs';
import path from 'node:path';
import { isFeatureSlug } from './docs.mjs';

export const DECISIONS = ['clear', 'need-info', 'high-risk'];
export const TYPES = ['bug', 'feature', 'enhancement', 'task'];

export function validatePlan(plan, ticketId) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan.json is missing or not an object'] };
  if (plan.ticketId !== ticketId) errors.push(`plan.json ticketId must be "${ticketId}"`);
  if (!DECISIONS.includes(plan.decision)) errors.push(`decision must be one of ${DECISIONS.join(', ')}`);
  if (!TYPES.includes(plan.type)) errors.push(`type must be one of ${TYPES.join(', ')}`);
  if (typeof plan.summary !== 'string' || !plan.summary.trim()) errors.push('summary is required');
  if (plan.decision === 'need-info' && (typeof plan.question !== 'string' || !plan.question.trim())) errors.push('need-info needs a plain-English question');
  if (plan.decision === 'high-risk' && (typeof plan.riskReason !== 'string' || !plan.riskReason.trim())) errors.push('high-risk needs a riskReason');
  if (plan.decision === 'clear' || plan.decision === 'high-risk') {
    if (!isFeatureSlug(plan.feature)) errors.push('feature must be a folder-safe name such as "leave-calendar" (letters, digits, - and _)');
    if (typeof plan.title !== 'string' || !plan.title.trim()) errors.push('title (feature display name) is required');
    if (!Array.isArray(plan.keywords) || plan.keywords.length === 0) errors.push('keywords must list words that identify the feature');
    const ac = plan.acceptance;
    if (!Array.isArray(ac) || ac.length === 0) errors.push('acceptance needs at least one check');
    else {
      const seen = new Set();
      for (const a of ac) {
        if (!a || !/^AC\d+$/.test(a.id) || typeof a.text !== 'string' || !a.text.trim()) errors.push('each acceptance check needs id like AC1 and text');
        else if (seen.has(a.id)) errors.push(`duplicate acceptance id ${a.id}`);
        else seen.add(a.id);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// Cheap change detector used to prove the planning agent did not edit the project (it may only write plan.json).
export function snapshot(root, ignoreNames, ignoreRel = []) {
  const ignore = new Set(ignoreNames);
  const skipRel = ignoreRel.map((p) => p.split(path.sep).join('/'));
  const out = new Map();
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignore.has(e.name) || skipRel.includes(r)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try { const s = fs.statSync(abs); out.set(r, `${s.size}:${Math.floor(s.mtimeMs)}`); } catch { /* vanished */ }
      }
    }
  };
  walk(root, '');
  return out;
}

export function diffSnapshots(a, b) {
  const changed = [];
  for (const [k, v] of b) if (a.get(k) !== v) changed.push(k);
  for (const k of a.keys()) if (!b.has(k)) changed.push(k);
  return changed;
}
