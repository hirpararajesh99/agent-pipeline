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
