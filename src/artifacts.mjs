import fs from 'node:fs';
import path from 'node:path';
import { fileHash, readmeRel } from './docs.mjs';
import { isInside, readJson } from './util.mjs';

const BAD_PATH_CHARS = /[\u0000-\u001f"%`$]/;
const str = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * The agent's claims are verified, not trusted.
 * park.json  : plain-English summary + changed files and deleted files that belong to this ticket (only these are ever checked in)
 * qa.json    : real steps; with a plan, every acceptance check (AC1, AC2 ...) must be covered by an assert step
 * README     : with a plan, the feature README must change (or park.json explains why not)
 * lesson.json: required on a redo, so the same mistake is not repeated
 */
export function validateArtifacts({ cfg, ticketId, workDir, artifactsDir, plan = null, docsBefore = null, isRedo = false }) {
  const errors = [];
  const load = (name) => {
    try { return readJson(path.join(artifactsDir, name), null); } catch (e) { errors.push(e.message); return undefined; }
  };
  const park = load('park.json');
  const qa = load('qa.json');

  if (park === null) errors.push('park.json is missing');
  else if (park) {
    if (park.ticketId !== ticketId) errors.push(`park.json ticketId must be "${ticketId}"`);
    if (!str(park.summary)) errors.push('park.json needs a plain-English summary');
    const files = park.files;
    const deletedFiles = park.deletedFiles ?? [];
    if (!Array.isArray(files)) errors.push('park.json files must be an array');
    if (!Array.isArray(deletedFiles)) errors.push('park.json deletedFiles must be an array when provided');
    if (Array.isArray(files) && Array.isArray(deletedFiles) && files.length + deletedFiles.length === 0) {
      errors.push('park.json must list changed files or deletedFiles');
    }
    const checkPaths = (items, label, shouldExist) => {
      if (!Array.isArray(items)) return;
      for (const f of items) {
        if (typeof f !== 'string' || !f || BAD_PATH_CHARS.test(f)) { errors.push(`park.json has an unsafe ${label} name: ${JSON.stringify(f)}`); continue; }
        const abs = path.resolve(workDir, f);
        if (!isInside(workDir, abs)) errors.push(`park.json ${label} is outside the workspace: ${f}`);
        else if (shouldExist && !fs.existsSync(abs)) errors.push(`park.json file does not exist: ${f}`);
        else if (!shouldExist && fs.existsSync(abs)) errors.push(`park.json deleted file still exists: ${f}`);
      }
    };
    checkPaths(files, 'file', true);
    checkPaths(deletedFiles, 'deleted file', false);
    if (Array.isArray(files) && Array.isArray(deletedFiles)) {
      const changed = new Set(files);
      for (const f of deletedFiles) if (changed.has(f)) errors.push(`park.json file is listed as both changed and deleted: ${f}`);
    }
  }

  if (qa === null) errors.push('qa.json is missing');
  else if (qa) {
    if (!Array.isArray(qa.steps) || qa.steps.length === 0) errors.push('qa.json needs real test steps');
    else {
      const asserting = qa.steps.filter((s) => s && (s.assert || s.expect));
      if (cfg.artifacts.requireQaAssert && asserting.length === 0) errors.push('qa.json steps must include at least one assert/expect');
      if (plan && cfg.plan.requireQaCoverage) {
        const covered = new Set(asserting.flatMap((s) => (Array.isArray(s.covers) ? s.covers : [])));
        for (const a of plan.acceptance ?? []) if (!covered.has(a.id)) errors.push(`qa.json does not cover ${a.id} (add "covers": ["${a.id}"] to a step that asserts it)`);
      }
    }
  }

  let readmeChanged = false;
  if (plan && cfg.docs.requireUpdate) {
    const rel = readmeRel(cfg, plan.feature);
    const now = fileHash(path.join(workDir, rel));
    readmeChanged = now !== null && now !== (docsBefore?.hash ?? null);
    const why = park?.docsUnchangedReason;
    if (!readmeChanged && !(typeof why === 'string' && why.trim().length >= 10)) {
      errors.push(`feature README ${rel} was not updated; describe the new behaviour there, or set docsUnchangedReason in park.json`);
    }
  }

  let lesson = null;
  if (isRedo && cfg.docs.requireLessonOnRedo) {
    lesson = load('lesson.json');
    if (lesson === null) errors.push('lesson.json is missing (required on a redo: title, symptom, rootCause, rule, keywords)');
    else if (lesson && !(str(lesson.title) && str(lesson.symptom) && str(lesson.rootCause) && str(lesson.rule))) {
      errors.push('lesson.json needs title, symptom, rootCause and rule');
      lesson = null;
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    files: Array.isArray(park?.files) ? park.files : [],
    deletedFiles: Array.isArray(park?.deletedFiles) ? park.deletedFiles : [],
    summary: park?.summary ?? '',
    lesson: lesson || null,
    readmeChanged,
  };
}
