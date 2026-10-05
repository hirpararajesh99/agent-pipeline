import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { State } from './state.mjs';
import { createTracker } from './adapters/trackers/index.mjs';
import { runOnce } from './orchestrator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
}

function err(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

// ── state snapshot ────────────────────────────────────────────────────────────

async function getSnapshot(cfg, tracker) {
  const state = new State(cfg.stateDir);

  let queue = [];
  try {
    const redo  = await tracker.list(['redo']);
    const ready = await tracker.list(['ready']);
    queue = [
      ...redo.map((t) => ({ ...t, statusKey: 'redo' })),
      ...ready.map((t) => ({ ...t, statusKey: 'ready' })),
    ];
  } catch { /* tracker unavailable */ }

  const providerHolds = [];
  try {
    fs.readdirSync(cfg.stateDir)
      .filter((f) => f.startsWith('hold-') && f.endsWith('.json'))
      .forEach((f) => {
        const key = f.replace(/\.json$/, '');
        const h   = state.get(key);
        if (h && h.until > Date.now()) {
          providerHolds.push({ provider: key.slice(5), reason: h.reason, until: new Date(h.until).toISOString() });
        }
      });
  } catch { /* no holds dir */ }

  return {
    paused:       state.isPaused(),
    inflight:     state.get('inflight'),
    deployReady:  state.get('deploy-ready', []),
    queue,
    failures:     state.get('failures', {}),
    planFailures: state.get('plan-failures', {}),
    attempts:     state.get('attempts', {}),
    heldTickets:  state.get('hold', []),
    providerHolds,
    recentEvents: state.recentEvents(25),
    config: {
      name:          cfg.name,
      agentProvider: cfg.agent.provider,
      trackerType:   cfg.tracker.type,
      vcsType:       cfg.vcs.type,
      maxAttempts:   cfg.limits.maxAttempts,
      batchMin:      cfg.deploy.batchMin,
      maxMinutes:    cfg.agent.maxMinutes,
    },
    timestamp: new Date().toISOString(),
  };
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

// ── server factory ────────────────────────────────────────────────────────────

export function createServer(cfg, opts = {}) {
  const port    = opts.port ?? 3000;
  const tracker = createTracker(cfg);
  const html    = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

  // Poll every 2 s and push to SSE clients when anything changed
  let lastKey = '';
  const pollInterval = setInterval(async () => {
    if (!clients.size) return;
    try {
      const snap = await getSnapshot(cfg, tracker);
      const key  = JSON.stringify({
        paused:      snap.paused,
        inflight:    snap.inflight,
        deployLen:   snap.deployReady.length,
        queueLen:    snap.queue.length,
        lastEvent:   snap.recentEvents.at(-1)?.ts,
        holds:       snap.providerHolds.length,
      });
      if (key !== lastKey) { lastKey = key; broadcast({ type: 'state', payload: snap }); }
    } catch { /* ignore transient errors */ }
  }, 2000);

  const server = http.createServer(async (req, res) => {
    const url      = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Dashboard HTML ────────────────────────────────────────────────────────
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── SSE stream ────────────────────────────────────────────────────────────
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      try {
        const snap = await getSnapshot(cfg, tracker);
        res.write(`data: ${JSON.stringify({ type: 'state', payload: snap })}\n\n`);
      } catch { /* best-effort */ }
      req.on('close', () => clients.delete(res));
      return;
    }

    // ── Full state snapshot ───────────────────────────────────────────────────
    if (pathname === '/api/state' && req.method === 'GET') {
      try { json(res, await getSnapshot(cfg, tracker)); }
      catch (e) { err(res, e.message, 500); }
      return;
    }

    // ── Ticket detail ─────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/ticket/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/ticket/'.length));
      try {
        const state    = new State(cfg.stateDir);
        const t        = await tracker.get(id);
        const comments = await tracker.getComments(id).catch(() => []);
        json(res, {
          ...t,
          comments,
          plan:        state.get(`plan-${id}`),
          pendingPlan: state.get(`plan-${id}-pending`),
          failure:     (state.get('failures', {}))[id] ?? null,
          planFailure: (state.get('plan-failures', {}))[id] ?? null,
          attempts:    (state.get('attempts', {}))[id] ?? 0,
        });
      } catch (e) { err(res, e.message, 404); }
      return;
    }

    // ── Pause ─────────────────────────────────────────────────────────────────
    if (pathname === '/api/pause' && req.method === 'POST') {
      new State(cfg.stateDir).pause();
      broadcast({ type: 'action', action: 'paused' });
      json(res, { ok: true });
      return;
    }

    // ── Unpause ───────────────────────────────────────────────────────────────
    if (pathname === '/api/unpause' && req.method === 'POST') {
      new State(cfg.stateDir).unpause();
      broadcast({ type: 'action', action: 'unpaused' });
      json(res, { ok: true });
      return;
    }

    // ── Trigger a pipeline run ────────────────────────────────────────────────
    if (pathname === '/api/run' && req.method === 'POST') {
      const job = url.searchParams.get('job') ?? 'all';
      runOnce(cfg, {}, { job })
        .then((r)  => broadcast({ type: 'run-result', payload: r }))
        .catch((e) => broadcast({ type: 'run-error', error: e.message }));
      json(res, { ok: true, job });
      return;
    }

    // ── Approve a high-risk plan (set ticket to ready) ────────────────────────
    if (pathname.startsWith('/api/approve/') && req.method === 'POST') {
      const id = decodeURIComponent(pathname.slice('/api/approve/'.length));
      try {
        await tracker.setStatus(id, 'ready');
        broadcast({ type: 'action', action: 'approved', ticket: id });
        json(res, { ok: true });
      } catch (e) { err(res, e.message); }
      return;
    }

    // ── Manually set ticket status ────────────────────────────────────────────
    if (pathname.startsWith('/api/set-status/') && req.method === 'POST') {
      const id = decodeURIComponent(pathname.slice('/api/set-status/'.length));
      try {
        const { statusKey } = await body(req);
        await tracker.setStatus(id, statusKey);
        broadcast({ type: 'action', action: 'status-set', ticket: id, statusKey });
        json(res, { ok: true });
      } catch (e) { err(res, e.message); }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('close', () => clearInterval(pollInterval));

  server.listen(port, '127.0.0.1', () => {
    const addr = `http://localhost:${port}`;
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  agent-pipeline dashboard               │`);
    console.log(`  │  ${addr}                    │`);
    console.log(`  └─────────────────────────────────────────┘`);
    console.log(`\n  Press Ctrl+C to stop.\n`);

    // Auto-open browser
    const open = { win32: 'start', darwin: 'open', linux: 'xdg-open' }[process.platform] ?? 'xdg-open';
    import('node:child_process')
      .then(({ execSync }) => { try { execSync(`${open} ${addr}`); } catch { /* not critical */ } })
      .catch(() => {});
  });

  return server;
}
