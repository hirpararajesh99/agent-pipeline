import { readJson, writeJson } from '../../util.mjs';

/** JSON-file tracker: for demos, tests and dry runs. Format: [{ id, title, description, status, comments: [] }] */
export function fileTracker(cfg) {
  const file = cfg.tracker.file;
  const names = cfg.tracker.statuses;
  const keyOf = (name) => Object.keys(names).find((k) => names[k] === name) ?? null;
  const load = () => readJson(file, []);
  const shape = (t) => ({ id: t.id, title: t.title, description: t.description ?? '', status: t.status, statusKey: keyOf(t.status) });
  return {
    async list(keys) {
      const wanted = new Set(keys.map((k) => names[k]));
      return load().filter((t) => wanted.has(t.status)).map(shape);
    },
    async get(id) {
      const t = load().find((x) => x.id === id);
      if (!t) throw new Error(`Ticket ${id} not found in ${file}`);
      return shape(t);
    },
    async getComments(id) {
      const t = load().find((x) => x.id === id);
      return (t?.comments ?? []).map(String);
    },
    async setStatus(id, key) {
      const all = load();
      const t = all.find((x) => x.id === id);
      if (!t) throw new Error(`Ticket ${id} not found`);
      t.status = names[key];
      writeJson(file, all);
    },
    async comment(id, text) {
      const all = load();
      const t = all.find((x) => x.id === id);
      if (!t) throw new Error(`Ticket ${id} not found`);
      (t.comments ??= []).push(text);
      writeJson(file, all);
    },
  };
}
