import { sleep } from '../../util.mjs';

const API = 'https://api.clickup.com/api/v2';

/** ClickUp REST v2 tracker. Token comes from the env var named in tracker.tokenEnv. */
export function clickupTracker(cfg) {
  const t = cfg.tracker;
  const names = t.statuses;
  const token = () => {
    const v = process.env[t.tokenEnv];
    if (!v) throw new Error(`Environment variable ${t.tokenEnv} is not set (ClickUp API token).`);
    return v;
  };
  const keyOf = (name) => Object.keys(names).find((k) => names[k].toLowerCase() === String(name).toLowerCase()) ?? null;

  async function call(method, url, body) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${API}${url}`, {
        method,
        headers: { Authorization: token(), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`ClickUp ${method} ${url} failed: HTTP ${res.status}`);
      return res.json();
    }
    throw new Error(`ClickUp ${method} ${url} kept hitting the rate limit`);
  }

  const shape = (x) => ({
    id: x.id,
    title: x.name,
    description: x.text_content ?? x.description ?? '',
    status: x.status?.status ?? '',
    statusKey: keyOf(x.status?.status),
    tags: (x.tags ?? []).map((g) => g.name.toLowerCase()),
    created: Number(x.date_created ?? 0),
  });

  return {
    async list(keys) {
      const out = [];
      for (let page = 0; page < 50; page++) {
        const p = new URLSearchParams({ page: String(page), include_closed: 'false' });
        for (const k of keys) p.append('statuses[]', names[k]);
        for (const g of t.tags) p.append('tags[]', g);
        for (const a of t.assignees) p.append('assignees[]', a);
        const data = await call('GET', `/list/${t.listId}/task?${p}`);
        out.push(...data.tasks.map(shape));
        if (data.last_page !== false) break;
      }
      const skip = new Set(t.skipTags.map((s) => s.toLowerCase()));
      return out.filter((x) => !x.tags.some((g) => skip.has(g))).sort((a, b) => a.created - b.created);
    },
    async get(id) { return shape(await call('GET', `/task/${id}`)); },
    async getComments(id) {
      const data = await call('GET', `/task/${id}/comment`);
      return (data.comments ?? []).map((c) => c.comment_text ?? '').filter(Boolean).reverse();
    },
    async setStatus(id, key) { await call('PUT', `/task/${id}`, { status: names[key] }); },
    async comment(id, text) { await call('POST', `/task/${id}/comment`, { comment_text: text, notify_all: false }); },
  };
}
