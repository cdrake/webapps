import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalReport, publishApprovalReport } from '../scripts/lib/ci-approvals.mjs';

const run = (id, conclusion, head_sha = 'abc123') => ({ id, conclusion, head_sha, status: 'completed', run_attempt: 1 });

test('approval reporting groups commits and distinguishes failures, cancellations and approvals', async () => {
  const client = {
    async list(path) {
      if (path.startsWith('/actions/runs?')) return [run(1, 'action_required'), run(2, 'action_required'), run(3, 'failure'), run(4, 'failure'), run(5, 'cancelled'), run(6, 'success')];
      return path.includes('/4/') ? [{ conclusion: 'failure' }] : [];
    },
  };
  const report = await approvalReport(client, 'owner/repo');
  assert.deepEqual(report.counts, { failedWithJobs: 1, failedWithoutJobs: 1, pendingApproval: 2 });
  assert.match(report.body, /awaiting approval, 2 workflows/);
  assert.match(report.body, /failed without jobs, 1 workflows/);
  assert.doesNotMatch(report.body, /expired approval, 1 workflows/);
});

test('publishing is idempotent, ignores human issues, and closes a resolved report', async () => {
  const writes = [];
  const report = { body: '<!-- ci-approval-report -->\nreport', actionable: true };
  let issues = [{ number: 1, user: { login: 'human' }, body: report.body }];
  const client = { list: async () => issues, request: async (...args) => writes.push(args) };
  await publishApprovalReport(client, report);
  assert.equal(writes[0][0], '/issues');
  issues = [{ number: 2, user: { login: 'github-actions[bot]' }, state: 'open', body: report.body }];
  await publishApprovalReport(client, report);
  assert.equal(writes.length, 1);
  await publishApprovalReport(client, { ...report, actionable: false });
  assert.equal(writes[1][1].body.state, 'closed');
  assert.ok(writes.every(([path]) => path.startsWith('/issues')));
});

test('a newly pending commit notifies issue subscribers once', async () => {
  const sha = 'a'.repeat(40);
  const issue = { number: 7, user: { login: 'github-actions[bot]' }, state: 'open', body: '<!-- ci-approval-report -->' };
  const comments = [];
  const client = {
    list: async () => [issue],
    async request(path, { body }) {
      if (path.endsWith('/comments')) comments.push(body.body);
      else Object.assign(issue, body);
    },
  };
  const report = { body: `<!-- ci-approval-report -->\n<!-- ci-commit:${sha}:approval -->`, actionable: true };
  await publishApprovalReport(client, report);
  await publishApprovalReport(client, report);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /aaaaaaaaaaaa/);
});
