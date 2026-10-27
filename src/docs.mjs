import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './util.mjs';
import { lessonSelection } from './brain-lessons.mjs';

const STOP = new Set(('the and for with that this from have has had are was were not but you your our into when then than them they their there what which will would should ' +
  'could can may might just also only more most some any all each per via use used using add adds added new old get set show shows page button field screen user users ticket').split(' '));

export const tokens = (text) => [...new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
export const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
export const isFeatureSlug = (s) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(String(s));
const posix = (...p) => path.posix.join(...p.map((x) => String(x).replace(/\\/g, '/')));
const toArr = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []);
const cell = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').trim();

export function parseFrontMatter(text) {
  const t = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const k = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!k) continue;
    let v = k[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    meta[k[1]] = v;
  }
  return { meta, body: m[2] };
}

export function fileHash(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

export const readmeRel = (cfg, feature) => posix(cfg.docs.featuresDir, feature, 'README.md');

export function listFeatures(root, cfg) {
  const base = path.join(root, cfg.docs.featuresDir);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .flatMap((d) => {
      const rp = path.join(base, d.name, 'README.md');
      if (!fs.existsSync(rp)) return [];
      const { meta, body } = parseFrontMatter(fs.readFileSync(rp, 'utf8'));
      return [{ slug: d.name, title: meta.title || d.name, keywords: toArr(meta.keywords), paths: toArr(meta.paths), body, readme: readmeRel(cfg, d.name) }];
    });
}

function readIndexRows(root, cfg) {
  const file = path.join(root, cfg.docs.memoryIndex);
  if (!fs.existsSync(file)) return [];
  const dir = path.posix.dirname(String(cfg.docs.memoryIndex).replace(/\\/g, '/'));
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line) || /^\|\s*Date\s*\|/i.test(line)) continue;
    const c = line.split('|').slice(1, -1).map((s) => s.trim());
    if (c.length < 5) continue;
    const link = /\]\(([^)]+)\)/.exec(c[4]);
    rows.push({ date: c[0], ticket: c[1], feature: c[2], summary: c[3], file: link ? posix(dir, link[1]) : null });
  }
  return rows;
}

/**
 * Deterministic retrieval, no AI involved: which feature docs and lessons are relevant to this ticket.
 * The result is injected into the agent prompt as "read these first".
 */
export function findContext(root, cfg, { id, title, description, comments = [], hintFeature, paths = [] }) {
  const text = [title, description, ...comments].join(' ');
  const lower = text.toLowerCase();
  const tk = new Set(tokens(text));
  const features = listFeatures(root, cfg)
    .map((f) => {
      let s = 0;
      if (f.slug === hintFeature) s += 100;
      for (const k of f.keywords) if (lower.includes(String(k).toLowerCase())) s += 3;
      for (const w of tokens(f.title)) if (tk.has(w)) s += 2;
      if (lower.includes(f.slug) || lower.includes(f.slug.replace(/-/g, ' '))) s += 5;
      for (const p of f.paths) if (p && lower.includes(String(p).toLowerCase())) s += 4;
      const body = new Set(tokens(f.body));
      let overlap = 0;
      for (const w of tk) if (body.has(w)) overlap++;
      return { ...f, score: s + Math.min(overlap, 5) };
    })
    .filter((f) => f.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.docs.maxFeatures)
    .map((f) => {
      const dir = path.join(root, cfg.docs.featuresDir, f.slug);
      const changelog = fs.existsSync(path.join(dir, 'CHANGELOG.md')) ? posix(cfg.docs.featuresDir, f.slug, 'CHANGELOG.md') : null;
      const tdir = path.join(dir, 'tickets');
      const plans = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((n) => n.endsWith('.md')).sort().slice(-5).map((n) => posix(cfg.docs.featuresDir, f.slug, 'tickets', n)) : [];
      return { slug: f.slug, title: f.title, readme: f.readme, score: f.score, changelog, plans, paths: f.paths };
    });

  const slugs = new Set(features.map((f) => f.slug));
  const lessons = lessonSelection(root, cfg, readIndexRows(root, cfg), { text, paths: [...paths, ...features.flatMap((f) => f.paths)] })
    .map((r) => {
      let s = 0;
      if (id && r.ticket === id) s += 10;
      if (slugs.has(slugify(r.feature))) s += 5;
      let n = 0;
      for (const w of tokens(`${r.feature} ${r.summary}`)) if (tk.has(w)) n++;
      return { ...r, score: s + Math.min(n, 4) };
    })
    .filter((r) => r.score >= 3 && r.file && fs.existsSync(path.join(root, r.file)))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.docs.maxLessons)
    .map((r) => ({ file: r.file, summary: r.summary, ticket: r.ticket, review: r.review,
      scope: r.scope, applicability: r.applicability, revision: r.revision, freshness: r.freshness }));
  return { features, lessons };
}

export function seedReadme(root, cfg, plan) {
  const rel = readmeRel(cfg, plan.feature);
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) return { rel, created: false };
  ensureDir(path.dirname(abs));
  const kw = (plan.keywords ?? []).join(', ');
  fs.writeFileSync(abs, `---
feature: ${plan.feature}
title: ${cell(plan.title)}
keywords: [${kw}]
paths: [${(plan.files ?? []).slice(0, 8).join(', ')}]
updated: ${new Date().toISOString().slice(0, 10)}
---
# ${cell(plan.title)}

Current behaviour as proven in code. This is not a product wishlist.

## Current behaviour

${plan.currentBehaviour?.trim() || 'Not documented yet. Document what the code does today before changing it.'}

## Rules and decisions

- (none recorded yet)

## Known limits

- (none recorded yet)
`);
  return { rel, created: true };
}

export function writePlanDoc(root, cfg, plan, ticket) {
  const rel = posix(cfg.docs.featuresDir, plan.feature, 'tickets', `${ticket.id}.md`);
  const abs = path.join(root, rel);
  ensureDir(path.dirname(abs));
  const list = (a) => (a?.length ? a.map((x) => `- ${x}`).join('\n') : '- none');
  fs.writeFileSync(abs, `## Ticket
- Id: ${ticket.id}
- Title: ${cell(ticket.title)}
- Type: ${plan.type}
- Feature: ${plan.feature}
- Planned: ${plan.plannedAt ?? ''} (plan version ${plan.version ?? 1})
- Decision: ${plan.decision}

## Summary

${plan.summary}

## Scope

${list(plan.scope)}

## Out of scope

${list(plan.outOfScope)}

## Likely files

${list(plan.files)}

## Acceptance checks

${(plan.acceptance ?? []).map((a) => `- ${a.id}: ${a.text}`).join('\n')}

## Risks

${list(plan.risks)}

## QA focus

${plan.qaFocus || 'Cover every acceptance check.'}
`);
  return rel;
}

export function appendChangelog(root, cfg, { feature, ticket, summary }) {
  const rel = posix(cfg.docs.featuresDir, feature, 'CHANGELOG.md');
  const abs = path.join(root, rel);
  ensureDir(path.dirname(abs));
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, '# Changelog\n\nWritten by the pipeline when a ticket is checked in.\n\n');
  const line = `- ${new Date().toISOString().slice(0, 10)} · ${ticket.id} · ${cell(ticket.title)} — ${cell(summary).slice(0, 300)}`;
  const text = fs.readFileSync(abs, 'utf8');
  if (!text.includes(line)) fs.appendFileSync(abs, (text.endsWith('\n') ? '' : '\n') + line + '\n');
  return rel;
}

export function writeLesson(root, cfg, { ticket, feature, lesson }) {
  const date = new Date().toISOString().slice(0, 10);
  const name = `${date.replace(/-/g, '')}-${ticket.id}-${slugify(lesson.title)}.md`;
  const rel = posix(cfg.docs.lessonsDir, name);
  const abs = path.join(root, rel);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, `---
ticket: ${ticket.id}
feature: ${feature}
date: ${date}
keywords: [${(lesson.keywords ?? []).join(', ')}]
---
# ${cell(lesson.title)}

Ticket ${ticket.id}.

## What went wrong

${lesson.symptom}

## Root cause

${lesson.rootCause}

## Rule

${lesson.rule}
`);
  const idxRel = String(cfg.docs.memoryIndex).replace(/\\/g, '/');
  const idx = path.join(root, idxRel);
  ensureDir(path.dirname(idx));
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, '# Memory index\n\nThe plan and coding agents read this table first, then open matching lesson files.\n\n| Date | Ticket | Feature | Decision | Lesson |\n| --- | --- | --- | --- | --- |\n');
  const link = path.posix.relative(path.posix.dirname(idxRel), rel);
  const row = `| ${date} | ${ticket.id} | ${cell(feature)} | ${cell(lesson.rule).slice(0, 160)} | [${slugify(lesson.title)}](${link}) |`;
  const text = fs.readFileSync(idx, 'utf8');
  if (!text.includes(`](${link})`)) fs.appendFileSync(idx, (text.endsWith('\n') ? '' : '\n') + row + '\n');
  return [rel, idxRel];
}

export function rebuildFeatureIndex(root, cfg) {
  const rel = String(cfg.docs.featureIndex).replace(/\\/g, '/');
  const abs = path.join(root, rel);
  ensureDir(path.dirname(abs));
  const rows = listFeatures(root, cfg).sort((a, b) => a.slug.localeCompare(b.slug))
    .map((f) => `| ${cell(f.title)} | \`${f.slug}\` | ${cell(f.keywords.join(', '))} | [README](${path.posix.relative(path.posix.dirname(rel), f.readme)}) |`);
  fs.writeFileSync(abs, `# Feature index

Generated by \`agent-pipeline docs index\`. Do not edit by hand.
Each feature README describes the current behaviour and is the first thing an agent reads.

| Feature | Folder | Keywords | Doc |
| --- | --- | --- | --- |
${rows.join('\n')}
`);
  return rel;
}
