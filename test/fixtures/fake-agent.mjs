// Stand-in for Codex/Cursor/Claude. Reads the prompt on stdin, behaves per FAKE_PLAN (plan job) or FAKE_MODE (code job).
import fs from 'node:fs';
import path from 'node:path';

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const get = (label) => new RegExp(`^${label}: (.+)$`, 'm').exec(prompt)?.[1].trim();
  const job = get('JOB');
  const id = get('ASSIGNED TICKET');
  const art = get('ARTIFACTS DIR');
  const workDir = get('WORK DIR') ?? process.cwd();
  if (job === 'BRAIN' || prompt.includes('Only write .project-brain/runs/')) {
    const line = prompt.split('\n').find((value) => value.startsWith('Only write '));
    const marker = prompt.indexOf('Only write ');
    const output = prompt.slice(marker + 11, prompt.indexOf('.json', marker) + 5);
    const stage = path.basename(output, '.json');
    const runDir = path.dirname(path.dirname(output));
    const index = JSON.parse(fs.readFileSync(path.join(process.cwd(), runDir, 'knowledge', 'project.json'), 'utf8'));
    const evidencePath = index.selectedFiles.find((file) => file.endsWith('.cs') || file.endsWith('.aspx')) ?? index.selectedFiles[0];
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, stage, snapshotId: index.snapshotId, scope: index.scope,
      summary: `Automated stage ${stage} summary`, findings: [{ id: `${stage}-automated`, statement: 'A project source file was inspected', certainty: 'verified', verification: 'Read the indexed source file.', evidence: [{ path: evidencePath, hash: index.files[evidencePath], startLine: 1, endLine: 1 }] }],
      unknowns: [], limitations: ['Fixture agent does not perform semantic analysis.'] }));
    return;
  }
  const brainSubmission = /Only write (\.project-brain\/runs\/[^\s]+\/submissions\/(\d\d)\.json)/.exec(prompt);
  if (brainSubmission) {
    const output = brainSubmission[1];
    const stage = brainSubmission[2];
    const runDir = path.dirname(path.dirname(output));
    const index = JSON.parse(fs.readFileSync(path.join(process.cwd(), runDir, 'knowledge', 'project.json'), 'utf8'));
    const evidencePath = index.selectedFiles.find((file) => /\.(?:cs|aspx)$/i.test(file)) ?? index.selectedFiles[0];
    const source = fs.readFileSync(path.join(process.cwd(), evidencePath), 'utf8');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({
      schemaVersion: 1, stage, snapshotId: index.snapshotId, scope: index.scope,
      summary: `Automated stage ${stage} summary`,
      findings: [{ id: `${stage}-automated`, statement: 'A project source file was inspected', certainty: 'verified', verification: 'Read the indexed source file.', evidence: [{ path: evidencePath, hash: index.files[evidencePath], startLine: 1, endLine: 1 }] }],
      unknowns: [], limitations: source ? ['Fixture agent does not perform semantic analysis.'] : [],
    }));
    return;
  }
  fs.mkdirSync(art, { recursive: true });
  const write = (f, o) => fs.writeFileSync(path.join(art, f), JSON.stringify(o));

  if (job === 'PLAN') {
    const pm = process.env.FAKE_PLAN ?? 'clear';
    const base = {
      ticketId: id, type: 'enhancement', feature: 'widgets', title: 'Widgets', keywords: ['widget', 'widgets'],
      summary: `Plan for ${id}`, currentBehaviour: 'Widgets are listed on the home page.', scope: ['widget list'], outOfScope: [],
      files: [`src/${id}.txt`], acceptance: [{ id: 'AC1', text: 'Widget visible' }, { id: 'AC2', text: 'Related list updated' }], risks: [], qaFocus: 'both',
    };
    if (pm === 'edit') fs.writeFileSync(path.join(process.cwd(), 'hacked.txt'), 'x');
    if (pm === 'needinfo') write('plan.json', { ...base, decision: 'need-info', question: 'Which account should be used?' });
    else if (pm === 'highrisk') write('plan.json', { ...base, decision: 'high-risk', riskReason: 'Changes the database schema' });
    else if (pm === 'bad') write('plan.json', { ticketId: id, decision: 'maybe' });
    else write('plan.json', { ...base, decision: 'clear' });
    return;
  }

  const mode = process.env.FAKE_MODE ?? 'good';
  if (mode === 'quota') { console.error('Error: usage limit reached, rate limit'); process.exit(1); }
  if (mode === 'needinfo') { write('needinfo.json', { question: 'Which account should this use?' }); return; }

  const plan = fs.existsSync(path.join(art, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(art, 'plan.json'), 'utf8')) : null;
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'src', `${id}.txt`), `feature for ${id}\n`);
  const files = mode === 'badpath' ? ['../evil.txt'] : [`src/${id}.txt`];
  write('park.json', { ticketId: id, summary: 'Added the thing', files, limitations: 'none' });
  let steps;
  if (mode === 'noassert') steps = [{ action: 'open' }];
  else if (plan && mode === 'nocover') steps = [{ action: 'open', assert: 'visible', covers: ['AC1'] }];
  else if (plan) steps = plan.acceptance.map((a) => ({ action: 'check', assert: a.text, covers: [a.id] }));
  else steps = [{ action: 'open', assert: 'thing visible' }];
  write('qa.json', { ticketId: id, loginProfile: 'default', steps });

  const readme = /Feature README: (\S+?)\. Read/.exec(prompt)?.[1];
  if (readme && mode !== 'nodocs') fs.appendFileSync(path.join(workDir, readme), `\n- Widgets now handled for ${id}\n`);
  if (prompt.includes('REDO PASS') && process.env.FAKE_LESSON !== 'skip') {
    write('lesson.json', { title: 'Check the related list', symptom: 'Related list stayed stale', rootCause: 'Only the main list was updated', rule: 'Always update every list that shows the value', keywords: ['list', 'widget'] });
  }
});
