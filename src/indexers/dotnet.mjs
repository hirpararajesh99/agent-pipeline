import fs from 'node:fs';
import path from 'node:path';

const posix = (p) => String(p).replace(/\\/g, '/');
const cs = (p) => path.extname(p).toLowerCase() === '.cs';
const project = (p) => /\.(?:csproj|vbproj|fsproj)$/i.test(p);
const markup = (p) => /\.(?:aspx|ascx|master|cshtml)$/i.test(p);

function relRef(from, raw) {
  const out = path.posix.normalize(path.posix.join(path.posix.dirname(from), posix(raw))).replace(/^\.\//, '');
  return out && !out.startsWith('../') ? out : null;
}

function read(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

function unique(items) {
  return [...new Map(items.map((v) => [`${v.from}\u0000${v.to}\u0000${v.kind}`, v])).values()];
}

/**
 * Evidence-only .NET analyzer for both .NET Framework and modern .NET.
 * It deliberately reports source/project relationships rather than guessing
 * runtime call graphs. Add language adapters through index.mjs over time.
 */
export function analyzeDotnet({ root, records }) {
  const paths = new Set(records.map((r) => r.path));
  const dotnetFiles = records.filter((r) => cs(r.path) || project(r.path) || /\.sln$/i.test(r.path) || markup(r.path) || /(?:^|\/)(?:web\.config|appsettings(?:\.[^.]+)?\.json|global\.asax)$/i.test(r.path));
  if (!dotnetFiles.length) return { nodes: [], edges: [] };

  const nodes = [];
  const edges = [];
  const types = new Map();
  const namespaces = new Map();

  for (const file of records.filter((r) => cs(r.path))) {
    const text = read(root, file.path);
    const namespace = /\bnamespace\s+([\w.]+)/.exec(text)?.[1] ?? '';
    if (namespace) {
      const id = `namespace:${namespace}`;
      nodes.push({ id, kind: 'namespace', label: namespace });
      edges.push({ from: file.path, to: id, kind: 'declares' });
      namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), file.path]);
    }
    const declaration = /\b(?:class|interface|record|struct|enum)\s+(\w+)/g;
    let m;
    while ((m = declaration.exec(text))) {
      const name = m[1];
      const id = `type:${namespace ? `${namespace}.` : ''}${name}`;
      nodes.push({ id, kind: 'type', label: name });
      edges.push({ from: file.path, to: id, kind: 'declares' });
      types.set(name, [...(types.get(name) ?? []), { id, file: file.path }]);
    }
  }

  for (const file of dotnetFiles) {
    const text = read(root, file.path);
    if (project(file.path)) {
      const refs = /<ProjectReference\s+[^>]*Include=["']([^"']+)["']/gi;
      let m;
      while ((m = refs.exec(text))) {
        const to = relRef(file.path, m[1]);
        if (to && paths.has(to)) edges.push({ from: file.path, to, kind: 'project-reference' });
      }
    }
    if (/\.sln$/i.test(file.path)) {
      const refs = /"([^"]+\.(?:csproj|vbproj|fsproj))"/gi;
      let m;
      while ((m = refs.exec(text))) {
        const to = relRef(file.path, m[1]);
        if (paths.has(to)) edges.push({ from: file.path, to, kind: 'solution-project' });
      }
    }
    if (markup(file.path)) {
      const codeBehind = /(?:CodeFile|CodeBehind)=["']([^"']+)["']/i.exec(text)?.[1];
      const to = codeBehind && relRef(file.path, codeBehind);
      if (to && paths.has(to)) edges.push({ from: file.path, to, kind: 'code-behind' });
    }
    if (!cs(file.path)) continue;

    const using = /\busing\s+([\w.]+)\s*;/g;
    let m;
    while ((m = using.exec(text))) {
      const id = `namespace:${m[1]}`;
      nodes.push({ id, kind: 'namespace', label: m[1] });
      edges.push({ from: file.path, to: id, kind: 'uses-namespace' });
    }

    const route = /(?:\[Route\(["']([^"']+)["']\)\]|\bMap(?:Get|Post|Put|Delete|Methods)\s*\(\s*["']([^"']+)["'])/g;
    while ((m = route.exec(text))) {
      const value = m[1] ?? m[2];
      const id = `route:${value}`;
      nodes.push({ id, kind: 'route', label: value });
      edges.push({ from: file.path, to: id, kind: 'defines-route' });
    }

    const service = /\bAdd(?:Scoped|Transient|Singleton)\s*<\s*(\w+)\s*,\s*(\w+)\s*>/g;
    while ((m = service.exec(text))) {
      for (const name of [m[1], m[2]]) for (const target of types.get(name) ?? []) edges.push({ from: file.path, to: target.file, kind: 'registers-service' });
    }

    for (const [name, targets] of types) {
      if (!new RegExp(`\\b${name}\\b`).test(text)) continue;
      for (const target of targets) if (target.file !== file.path) edges.push({ from: file.path, to: target.file, kind: 'uses-type' });
    }
  }
  return { nodes: [...new Map(nodes.map((n) => [n.id, n])).values()], edges: unique(edges) };
}
