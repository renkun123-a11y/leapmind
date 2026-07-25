import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalReport,
  contentHash,
  dateInShanghai,
  emailBody,
  hasBlockers,
  parseArgs,
  safeReason,
  sendReport,
  updateReport,
} from '../scripts/daily-report/send-member-report.mjs';

const member = '\u5f20\u6893\u9e3f';
const date = '2026-07-25';
const smtpConfig = { host: 'example.invalid', port: 465, secure: true, auth: { user: 'sender@example.com', pass: 'test-only' } };
const report = [
  '---',
  `date: ${date}`,
  `member: ${member}`,
  'module: M6 \u4e8b\u4ef6\u91c7\u96c6 API',
  'emailStatus: pending',
  '---',
  '',
  '# \u6bcf\u65e5\u5f00\u53d1\u8fdb\u5ea6\u62a5\u544a',
  '',
  '## \u4e8c\u3001\u4eca\u65e5\u5de5\u4f5c\u6982\u89c8',
  '',
  '\u771f\u5b9e\u5de5\u4f5c\u6458\u8981\u3002',
  '',
  '## \u4e09\u3001\u4eca\u65e5\u5b8c\u6210\u5185\u5bb9',
  '',
  '\u5b8c\u6210\u4e8b\u4ef6 API\u3002',
  '',
  '## \u516d\u3001\u5f53\u524d\u672a\u5b8c\u6210\u5185\u5bb9',
  '',
  '\u5f85\u5b8c\u6210\u96c6\u6210\u9a8c\u8bc1\u3002',
  '',
  '## \u4e03\u3001\u963b\u585e\u4e0e\u98ce\u9669',
  '',
  '\u65e0\u660e\u786e\u5f00\u53d1\u963b\u585e\u3002',
  '',
  '## \u516b\u3001\u4e0b\u4e00\u6b65\u8ba1\u5212',
  '',
  '\u8fd0\u884c\u96c6\u6210\u9a8c\u8bc1\u3002',
  '',
  '## \u5341\u3001\u90ae\u4ef6\u53d1\u9001\u8bb0\u5f55',
  '',
  '- **\u53d1\u9001\u72b6\u6001**\uff1a\u5f85\u53d1\u9001',
  '',
].join('\n');

async function withTempReport(markdown, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daily-report-'));
  const reportDirectory = path.join(root, 'reports', 'members', member);
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `${date}.md`);
  await writeFile(reportPath, markdown);
  try {
    return await run({ root, reportPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parses dry-run arguments without network options', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--member', member, '--date', date]), { dryRun: true, member, date });
});

test('normalizes delivery metadata out of the duplicate-send hash', () => {
  const sent = updateReport(report, { status: 'sent', hash: 'old', timestamp: '2026-07-25 10:00:00' });
  assert.equal(contentHash(report), contentHash(sent));
  assert.ok(canonicalReport(sent).includes('\u771f\u5b9e\u5de5\u4f5c\u6458\u8981'));
});

test('safeReason redacts SMTP fields and bearer credentials', () => {
  const reason = safeReason(new Error('SMTP_PASS=super-secret Authorization: token-123 Bearer abc.def'));
  assert.match(reason, /SMTP_PASS=\[redacted\]/);
  assert.match(reason, /Authorization:\[redacted\]/);
  assert.match(reason, /Bearer \[redacted\]/);
  assert.doesNotMatch(reason, /super-secret|token-123|abc\.def/);
});

test('generates a complete text and html body from the report headings', () => {
  const body = emailBody(report, `reports/members/${member}/${date}.md`);
  for (const label of ['\u6210\u5458', '\u6a21\u5757', '\u65e5\u671f', '\u4eca\u65e5\u6982\u8ff0', '\u5b8c\u6210', '\u672a\u5b8c\u6210', '\u963b\u585e\u4e0e\u98ce\u9669', '\u4e0b\u4e00\u6b65', '\u62a5\u544a\u8def\u5f84']) {
    assert.ok(body.text.includes(label));
  }
  assert.match(body.html, /reports\/members/);
  assert.equal(hasBlockers(report), false);
});

test('formats the requested Shanghai calendar date', () => {
  assert.equal(dateInShanghai(new Date('2026-07-24T16:30:00.000Z')), date);
});

test('dry-run reads the report but never initializes a mail transport or env loader', async () => {
  await withTempReport(report, async ({ root }) => {
    const result = await sendReport({
      root, member, date, dryRun: true,
      createTransport: () => { throw new Error('transport must not be created'); },
      loadEnv: () => { throw new Error('env must not be loaded'); },
    });
    assert.equal(result.status, 'dry-run');
  });
});

test('fake transport success sends the required attachment and records delivery', async () => {
  await withTempReport(report, async ({ root, reportPath }) => {
    const sent = [];
    const result = await sendReport({
      root, member, date, smtpConfig, loadEnv: () => {},
      createTransport: () => ({ sendMail: async (mail) => { sent.push(mail); } }),
    });
    assert.equal(result.status, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '306389zwt@gmail.com');
    assert.equal(sent[0].attachments[0].filename, `${member}-\u5f00\u53d1\u65e5\u62a5-${date}.md`);
    assert.equal(sent[0].subject, `\u3010\u6210\u5458\u5f00\u53d1\u65e5\u62a5\u3011${member} - ${date}`);
    const saved = await readFile(reportPath, 'utf8');
    assert.match(saved, /emailStatus: sent/);
  });
});

test('fake transport retries failures at most three times without waiting and keeps a redacted failure record', async () => {
  await withTempReport(report, async ({ root, reportPath }) => {
    let attempts = 0;
    await assert.rejects(() => sendReport({
      root, member, date, smtpConfig, loadEnv: () => {}, retryDelayMs: 0,
      createTransport: () => ({ sendMail: async () => { attempts += 1; throw new Error('SMTP_PASS=super-secret'); } }),
    }), /Daily report was preserved/);
    assert.equal(attempts, 3);
    const saved = await readFile(reportPath, 'utf8');
    assert.match(saved, /emailStatus: failed/);
    assert.match(saved, /\[redacted\]/);
    assert.doesNotMatch(saved, /super-secret/);
  });
});

test('same content after a sent record is deduplicated without initializing SMTP', async () => {
  const sentReport = updateReport(report, { status: 'sent', hash: contentHash(report), timestamp: '2026-07-25 10:00:00' });
  await withTempReport(sentReport, async ({ root }) => {
    const result = await sendReport({
      root, member, date,
      createTransport: () => { throw new Error('transport must not be created'); },
      loadEnv: () => { throw new Error('env must not be loaded'); },
    });
    assert.equal(result.status, 'skipped');
  });
});

test('changed sent report uses the update subject, while a blocker uses the blocker subject', async () => {
  const changedSent = updateReport(report, { status: 'sent', hash: 'old', timestamp: '2026-07-25 10:00:00' });
  await withTempReport(changedSent, async ({ root }) => {
    const subjects = [];
    await sendReport({ root, member, date, smtpConfig, loadEnv: () => {}, createTransport: () => ({ sendMail: async (mail) => subjects.push(mail.subject) }) });
    assert.equal(subjects[0], `\u3010\u6210\u5458\u5f00\u53d1\u65e5\u62a5\uff5c\u66f4\u65b0\u7248\u3011${member} - ${date}`);
  });
  const blocked = report.replace('\u65e0\u660e\u786e\u5f00\u53d1\u963b\u585e\u3002', '\u4f9d\u8d56\u6d4b\u8bd5\u73af\u5883\u3002');
  await withTempReport(blocked, async ({ root }) => {
    const subjects = [];
    await sendReport({ root, member, date, smtpConfig, loadEnv: () => {}, createTransport: () => ({ sendMail: async (mail) => subjects.push(mail.subject) }) });
    assert.equal(subjects[0], `\u3010\u6210\u5458\u5f00\u53d1\u65e5\u62a5\uff5c\u5b58\u5728\u963b\u585e\u3011${member} - ${date}`);
  });
});
