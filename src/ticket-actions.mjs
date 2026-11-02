// Actions change the selected ticket's tracker status; they do not start a job.
const ACTIONS = {
  new: [{ id: 'block', label: 'Mark blocked', target: 'blocked' }],
  resume: [{ id: 'block', label: 'Mark blocked', target: 'blocked' }],
  ready: [{ id: 'block', label: 'Mark blocked', target: 'blocked' }],
  redo: [{ id: 'block', label: 'Mark blocked', target: 'blocked' }],
  blocked: [{ id: 'replan', label: 'Send for re-planning', target: 'resume' }],
  needInfo: [{ id: 'replan', label: 'Send for re-planning', target: 'resume' }],
  approval: [
    { id: 'approve', label: 'Approve plan', target: 'ready' },
    { id: 'replan', label: 'Request plan changes', target: 'resume' },
  ],
};

export function ticketActions(statusKey) {
  return (ACTIONS[statusKey] ?? []).map((action) => ({ ...action }));
}
