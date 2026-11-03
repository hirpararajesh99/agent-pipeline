import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, safeProjectPath } from './util.mjs';
import { lessonSelection } from './brain-lessons.mjs';

const STOP = new Set(('the and for with that this from have has had are was were not but you your our into when then than them they their there what which will would should ' +
  'could can may might just also only more most some any all each per via use used using add adds added new old get set show shows page button field screen user users ticket').split(' '));

export const tokens = (text) => [...new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
export const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
export const isFeatureSlug = (s) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(String(s));
const posix = (...p) => path.posix.join(...p.map((x) => String(x).replace(/\\/g, '/')));
const toArr = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []);
const cell = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').trim();
const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 3);

function markdownSections(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = { heading: 'Introduction', lines: [] };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (current.lines.some((x) => x.trim())) sections.push(current);
      current = { heading: heading[2], lines: [line] };
    } else current.lines.push(line);
  }
  if (current.lines.some((x) => x.trim())) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

function relevance(text, words) {
  let score = 0;
  for (const word of tokens(text)) if (words.has(word)) score++;
  return score;
}

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
    const file = link ? posix(dir, link[1]) : null;
    const summary = file ? lessonRule(root, cfg, file) || c[3] : c[3];
    rows.push({ date: c[0], ticket: c[1], feature: c[2], summary, file });
  }
  return rows;
}

function lessonRule(root, cfg, rel) {
  const lessonBase = `${posix(cfg.docs.lessonsDir).replace(/\/+$/, '')}/`;
  if (!rel.startsWith(lessonBase)) return '';
  let file;
  try { file = safeProjectPath(root, rel); } catch { return ''; }
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(/^##\s+(.+?)\s*\n([\s\S]*?)(?=^##\s|\s*$)/gm)];
  const useful = headings.find((m) => /^(rule|guidance|do not repeat|rule of thumb)\b/i.test(m[1].trim()));
  return useful?.[2]?.trim() ?? '';
}

/**
 * Deterministic retrieval, no AI involved: which feature docs and lessons are relevant to this ticket.
 * The result is injected into plan/code prompts as ranked excerpts.
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
      const sectionCandidates = markdownSections(f.body).map((section) => ({
        ...section,
        score: relevance(`${section.heading} ${section.text}`, tk) + (f.score >= 100 ? 1 : 0),
        source: f.readme,
      })).sort((a, b) => b.score - a.score || a.heading.localeCompare(b.heading));
      const relevantSections = sectionCandidates.filter((section) => section.score > 0);
      const sections = (relevantSections.length ? relevantSections : sectionCandidates.slice(0, 1))
        .slice(0, cfg.docs.maxSectionsPerFeature ?? 4);
      const planCandidates = fs.existsSync(tdir)
        ? fs.readdirSync(tdir).filter((n) => n.endsWith('.md')).map((name) => {
          const rel = posix(cfg.docs.featuresDir, f.slug, 'tickets', name);
          const content = fs.readFileSync(path.join(tdir, name), 'utf8');
          const planScore = relevance(`${name} ${content}`, tk) + (id && name.startsWith(`${id}.`) ? 100 : 0);
          const sections = markdownSections(content).map((section) => ({
            ...section,
            score: relevance(`${section.heading} ${section.text}`, tk) + (id && name.startsWith(`${id}.`) ? 100 : 0),
          })).filter((section) => section.score > 0).sort((a, b) => b.score - a.score || a.heading.localeCompare(b.heading)).slice(0, cfg.docs.maxSectionsPerPlan ?? 3);
          return { file: rel, score: planScore, sections };
        }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, cfg.docs.maxTicketPlans ?? 2)
        : [];
      return { slug: f.slug, title: f.title, readme: f.readme, score: f.score, changelog, sections, plans: planCandidates, paths: f.paths };
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
    .map((r) => ({ file: r.file, summary: r.summary, ticket: r.ticket, review: r.review, score: r.score,
      scope: r.scope, applicability: r.applicability, revision: r.revision, freshness: r.freshness }));
  return { features, lessons };
}

/** Apply one deterministic budget to retrieved feature, lesson, and project-index context. */
export function fitContextBudget(context, indexContext, cfg, brain = { findings: [], decisions: [], conflicts: [], gaps: [] }) {
  const budget = cfg.knowledge.maxPromptContextTokens;
  const candidates = [];
  for (const feature of context.features) {
    for (const section of feature.sections ?? []) candidates.push({
      type: 'feature-section', score: section.score + Math.min(feature.score, 8), source: section.source,
      label: `${feature.title}: ${section.heading}`, text: section.text,
      apply: (target) => { target.features.find((f) => f.slug === feature.slug)?.sections.push(section); },
      feature: feature.slug,
    });
    for (const plan of feature.plans ?? []) for (const section of plan.sections) candidates.push({
      type: 'ticket-plan', score: section.score + Math.min(feature.score, 8) + 6, source: plan.file,
      label: `${feature.title} prior ticket: ${section.heading}`, text: section.text,
      apply: (target) => {
        const picked = target.features.find((f) => f.slug === feature.slug)?.plans;
        if (picked && !picked.some((p) => p.file === plan.file)) picked.push({ file: plan.file, sections: [] });
        picked?.find((p) => p.file === plan.file)?.sections.push(section);
      },
    });
  }
  for (const lesson of context.lessons) candidates.push({
    type: 'lesson', score: lesson.score + 10, source: lesson.file, label: `Lesson ${lesson.ticket}`,
    text: `${lesson.summary}\n${lesson.applicability ?? ''}`, apply: (target) => target.lessons.push(lesson),
  });
  for (const file of indexContext.files) candidates.push({
    type: 'source-path', score: (file.score ?? 1) + 2, source: file.path, label: `Source path ${file.path}`,
    text: `${file.path} ${file.kind} ${(file.refs ?? []).join(' ')}`,
      apply: (target) => target.index.files.push(file),
  });
  for (const edge of indexContext.edges) candidates.push({
    type: 'relationship', score: 1, source: `${edge.from} -> ${edge.to}`,
    label: `Relationship ${edge.from} -> ${edge.to}`, text: `${edge.from} ${edge.to}`,
    apply: (target) => target.index.edges.push(edge),
  });
  for (const finding of brain.findings) candidates.push({
    type: 'brain-finding', score: finding.score + 8, source: `default:${finding.id}`,
    label: `Brain finding ${finding.id}`, text: JSON.stringify(finding),
    apply: (target) => target.brain.findings.push(finding),
  });
  for (const decision of brain.decisions) candidates.push({
    type: 'brain-decision', score: decision.score + 10, source: `decision:${decision.id}`,
    label: `Developer decision ${decision.id}`, text: JSON.stringify(decision),
    apply: (target) => target.brain.decisions.push(decision),
  });
  for (const conflict of brain.conflicts ?? []) candidates.push({
    type: 'brain-conflict', score: conflict.score + 12, source: `conflict:${conflict.id}`,
    label: `Unresolved conflict ${conflict.id}`, text: JSON.stringify(conflict),
    apply: (target) => target.brain.conflicts.push(conflict),
  });

  candidates.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type) || a.source.localeCompare(b.source));
  const fitted = {
    features: context.features.map((f) => ({ ...f, sections: [], plans: [] })),
    lessons: [],
    brain: { findings: [], decisions: [], conflicts: [] },
    index: { files: [], edges: [], totalFiles: indexContext.totalFiles },
  };
  const selected = [];
  const omitted = [];
  let estimatedTokens = 0;
  for (const item of candidates) {
    const cost = estimateTokens(`${item.label} ${item.source}\n${JSON.stringify(item.text)}\n${'x'.repeat(48)}`);
    if (estimatedTokens + cost > budget) {
      omitted.push({ type: item.type, source: item.source, reason: 'context budget' });
      continue;
    }
    item.apply(fitted);
    estimatedTokens += cost;
    selected.push({ type: item.type, source: item.source, reason: `relevance score ${item.score}`, estimatedTokens: cost,
      ...(['brain-finding', 'brain-decision', 'brain-conflict'].includes(item.type) ? { detail: JSON.parse(item.text) } : {}) });
  }
  fitted.features = fitted.features.filter((f) => f.sections.length || f.plans.length);
  fitted.selection = {
    budgetTokens: budget,
    estimatedTokens,
    estimator: 'characters divided by three with formatting overhead; conservative estimate, not provider-exact',
    selected,
    omitted,
    gaps: [...(fitted.features.length ? [] : ['No relevant feature-document sections fit or matched the configured sources.']), ...brain.gaps],
  };
  return { context: fitted, indexContext: fitted.index, manifest: fitted.selection };
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
