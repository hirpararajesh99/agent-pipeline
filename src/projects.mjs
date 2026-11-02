import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './util.mjs';
import { acquireLock } from './lock.mjs';

/** Local registry metadata only. Project contents remain owned by each project. */
export function projectRegistry(file = path.join(os.homedir(), '.agent-pipeline', 'projects.json')) {
  const registryFile = path.resolve(file);
  const lockFile = `${registryFile}.lock`;
  const list = () => {
    const data = readJson(registryFile, { version: 1, projects: [] });
    if (!data || data.version !== 1 || !Array.isArray(data.projects) || data.projects.some((p) =>
      !p || typeof p.id !== 'string' || !/^[a-f0-9]{32}$/.test(p.id) ||
      typeof p.name !== 'string' || !p.name || typeof p.path !== 'string' || !path.isAbsolute(p.path))) {
      throw new Error('Invalid project registry');
    }
    if (new Set(data.projects.map((p) => p.id)).size !== data.projects.length) throw new Error('Duplicate project ID in registry');
    return data.projects;
  };
  const update = (fn) => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const lock = acquireLock(lockFile, { name: 'projects' });
    if (!lock) throw new Error('Project registry is locked');
    try {
      const projects = list();
      const result = fn(projects);
      writeJson(registryFile, { version: 1, projects });
      return result;
    } finally { lock.release(); }
  };
  const resolve = (id) => {
    const project = list().find((p) => p.id === id);
    if (!project) throw new Error('Project not found');
    const real = fs.realpathSync(project.path);
    if (compare(real) !== compare(project.path) || !fs.statSync(real).isDirectory()) {
      throw new Error('Project directory has moved or changed');
    }
    return project;
  };
  return {
    list,
    resolve,
    add({ name, directory }) {
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error('Project directory must be an absolute path');
      const real = fs.realpathSync(directory);
      if (!fs.statSync(real).isDirectory()) throw new Error('Project path must be a directory');
      const label = String(name ?? path.basename(real)).trim();
      if (!label || label.length > 120 || /[\x00-\x1f]/.test(label)) throw new Error('Project name must be 1–120 characters');
      return update((projects) => {
        if (projects.some((p) => compare(p.path) === compare(real))) throw new Error('Project directory is already registered');
        const project = { id: crypto.randomBytes(16).toString('hex'), name: label, path: real };
        projects.push(project);
        return project;
      });
    },
    remove(id) {
      return update((projects) => {
        const index = projects.findIndex((p) => p.id === id);
        if (index < 0) throw new Error('Project not found');
        return projects.splice(index, 1)[0];
      });
    },
  };
}

function compare(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
