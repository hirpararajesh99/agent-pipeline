import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokens } from './docs.mjs';
import { ensureDir, readJson, writeJson } from './util.mjs';
import { analyzeProject } from './indexers/index.mjs';

const TEXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.webmanifest', '.svg']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.svg']);
const posix = (p) => String(p).replace(/\\/g, '/');

function kindFor(ext) {
  if (ext === '.html' || ext === '.htm') return 'page';
  if (ext === '.css') return 'style';
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) return 'script';
  if (ext === '.webmanifest') return 'manifest';
  if (ext === '.cs') return 'csharp';
  if (/\.(?:csproj|vbproj|fsproj)$/i.test(ext)) return 'dotnet-project';
  if (ext === '.sln') return 'dotnet-solution';
  if (['.aspx', '.ascx', '.master', '.cshtml'].includes(ext)) return 'dotnet-view';
  if (IMAGE.has(ext)) return 'asset';
  return 'file';
}

function localRef(raw, from) {
  let ref = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  ref = ref.split(/[?#]/, 1)[0];
  if (!ref) return null;
  const resolved = ref.startsWith('/') ? ref.slice(1) : path.posix.join(path.posix.dirname(from), ref);
  const out = path.posix.normalize(resolved).replace(/^\.\//, '');
  return out && !out.startsWith('../') ? out : null;
}

function extractRefs(text, ext, rel) {
  const refs = [];
  const add = (value) => { const ref = localRef(value, rel); if (ref) refs.push(ref); };
  const attr = /\b(?:src|href|content)\s*=\s*["']([^"']+)["']/gi;
  const css = /(?:url\(\s*|@import\s+)["']?([^"'\)\s;]+)["']?/gi;
  const moduleRef = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  if (ext === '.html' || ext === '.htm' || ext === '.svg') while ((m = attr.exec(text))) add(m[1]);
  if (ext === '.css') while ((m = css.exec(text))) add(m[1]);
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) while ((m = moduleRef.exec(text))) add(m[1] ?? m[2]);
  if (ext === '.json' || ext === '.webmanifest') {
    try {
      const walk = (v, key = '') => {
        if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
        else if (typeof v === 'string' && /(?:src|href|icon|logo|image)/i.test(key)) add(v);
      };
      walk(JSON.parse(text));
    } catch { /* malformed JSON is not the indexer's responsibility */ }
  }
  return [...new Set(refs)];
}

function scanFiles(root, cfg) {
  const ignore = new Set(cfg.knowledge.ignore);
  const indexFiles = new Set([posix(cfg.knowledge.indexFile), posix(cfg.knowledge.graphFile)]);
  const files = [];
  const walk = (dir, rel = '') => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignore.has(e.name) || e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (indexFiles.has(childRel)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, childRel);
      else if (e.isFile()) files.push({ abs, rel: childRel });
    }
  };
  walk(root);
  return files;
}

/** Build a deterministic file/reference index. It never writes unless writeProjectIndex is called. */
export function buildProjectIndex(root, cfg) {
  if (!cfg.knowledge.enabled) return { version: 1, generatedAt: new Date().toISOString(), files: [], graph: { nodes: [], edges: [] } };
  const records = scanFiles(root, cfg).map(({ abs, rel }) => {
    const ext = path.extname(rel).toLowerCase();
    const stat = fs.statSync(abs);
    let refs = [];
    if (TEXT.has(ext) && stat.size <= cfg.knowledge.maxFileBytes) {
      try { refs = extractRefs(fs.readFileSync(abs, 'utf8'), ext, rel); } catch { /* non-text despite extension */ }
    }
    return {
      path: rel,
      kind: kindFor(ext),
      ext: ext || '',
      bytes: stat.size,
      hash: crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 12),
      refs,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(records.map((r) => r.path));
  const staticEdges = records.flatMap((r) => r.refs.filter((to) => paths.has(to)).map((to) => ({ from: r.path, to, kind: 'uses' })));
  const adapters = analyzeProject({ root, records, cfg });
  const edges = [...new Map([...staticEdges, ...adapters.edges].map((e) => [`${e.from}\u0000${e.to}\u0000${e.kind}`, e])).values()];
  const nodes = [...new Map([
    ...records.map((r) => ({ id: r.path, kind: r.kind })),
    ...adapters.nodes,
  ].map((n) => [n.id, n])).values()];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: records,
    graph: { nodes, edges },
  };
}

function markdown(index) {
  const rows = index.files.map((f) => `| \`${f.path}\` | ${f.kind} | ${f.refs.length} |`).join('\n');
  return `# Project index\n\nGenerated by \`agent-pipeline docs scan\`. Do not edit by hand.\n\n- Files: ${index.files.length}\n- Relationships: ${index.graph.edges.length}\n- Generated: ${index.generatedAt}\n\n| File | Kind | References |\n| --- | --- | ---: |\n${rows}\n`;
}

/** Persist the generated index and graph as versioned project knowledge. */
export function writeProjectIndex(root, cfg, index = buildProjectIndex(root, cfg)) {
  if (!cfg.knowledge.enabled) return [];
  const indexRel = posix(cfg.knowledge.indexFile);
  const graphRel = posix(cfg.knowledge.graphFile);
  const mdRel = posix(cfg.knowledge.indexMarkdown);
  writeJson(path.join(root, indexRel), { version: index.version, generatedAt: index.generatedAt, files: index.files });
  writeJson(path.join(root, graphRel), { version: index.version, generatedAt: index.generatedAt, ...index.graph });
  const md = path.join(root, mdRel);
  ensureDir(path.dirname(md));
  fs.writeFileSync(md, markdown(index));
  return [indexRel, graphRel, mdRel];
}

export function loadProjectIndex(root, cfg) {
  const saved = readJson(path.join(root, cfg.knowledge.indexFile), null);
  const graph = readJson(path.join(root, cfg.knowledge.graphFile), null);
  if (!saved || !graph) return null;
  return { ...saved, graph: { nodes: graph.nodes ?? [], edges: graph.edges ?? [] } };
}

/** Compact, evidence-linked context for an agent. It deliberately lists paths rather than code content. */
export function findIndexContext(index, cfg, { title, description, comments = [], featureContext = null }) {
  if (!index?.files?.length) return { files: [], edges: [], totalFiles: 0 };
  const words = new Set(tokens([title, description, ...comments].join(' ')));
  const featurePaths = (featureContext?.features ?? []).flatMap((f) => f.paths ?? []);
  const ranked = index.files.map((f) => {
    const lower = f.path.toLowerCase();
    let score = 0;
    for (const w of words) if (lower.includes(w)) score += 2;
    for (const p of featurePaths) if (p && (lower.startsWith(String(p).replace(/\\/g, '/')) || lower.includes(String(p).replace(/\\/g, '/')))) score += 8;
    return { ...f, score };
  }).filter((f) => f.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const picked = ranked.slice(0, cfg.knowledge.maxContextFiles);
  const ids = new Set(picked.map((f) => f.path));
  const edges = index.graph.edges.filter((e) => ids.has(e.from) || ids.has(e.to)).slice(0, cfg.knowledge.maxContextEdges);
  return { files: picked.map(({ path: file, kind, refs }) => ({ path: file, kind, refs: refs.slice(0, 6) })), edges, totalFiles: index.files.length };
}

export function findImpact(index, requested) {
  const target = posix(requested).replace(/^\.\//, '');
  const edges = index?.graph?.edges ?? [];
  const direct = edges.filter((e) => e.from === target || e.to === target);
  return { target, exists: !!index?.files?.some((f) => f.path === target), direct, related: [...new Set(direct.flatMap((e) => [e.from, e.to]).filter((p) => p !== target))] };
}
