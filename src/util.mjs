import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write-then-rename so a crash can never leave a half-written state file.
export function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Missing file -> fallback. Corrupt file -> throws (never silently reset state).
// A UTF-8 BOM is stripped, because editors and agents on Windows add one.
export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
}

export const writeJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n');

// Knowledge paths must stay relative and must not traverse symlinks/junctions.
export function safeProjectPath(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') ||
      path.posix.isAbsolute(rel) || rel.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new Error('Brain path must be a canonical project-relative path');
  }
  let target = root;
  for (const part of rel.split('/')) {
    target = path.join(target, part);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Brain path traverses a symlink: ${rel}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

export function render(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export const isSafeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id));

// Text that ends up inside a shell command (commit messages etc.) is reduced to a safe alphabet.
export function sanitizeText(s, max = 120) {
  return String(s ?? '')
    .replace(/[^\w .,:()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function shellQuote(arg) {
  const s = String(arg);
  if (isWin) return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export const tail = (text, n = 2000) => (text.length > n ? text.slice(-n) : text);

// Best-effort masking before text is posted to a tracker. Not a substitute for keeping secrets out of logs.
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out.replace(/(authorization|token|password|passwd|secret|api[_-]?key|pat)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]');
}
