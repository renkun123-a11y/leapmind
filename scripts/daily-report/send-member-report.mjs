import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

const RECIPIENT = '306389zwt@gmail.com';
const RETRIES = 3;
const RETRY_DELAY_MS = 30_000;
const WORK_HEADING = '\u4e8c\u3001\u4eca\u65e5\u5de5\u4f5c\u6982\u89c8';
const MAIL_LOG_HEADING = '\u5341\u3001\u90ae\u4ef6\u53d1\u9001\u8bb0\u5f55';
const MEMBER_NAME = '\u5f20\u6893\u9e3f';
const DAILY_REPORT_LABEL = '\u5f00\u53d1\u65e5\u62a5';
const COMPLETED_HEADING = '\u4e09\u3001\u4eca\u65e5\u5b8c\u6210\u5185\u5bb9';
const UNFINISHED_HEADING = '\u516d\u3001\u5f53\u524d\u672a\u5b8c\u6210\u5185\u5bb9';
const BLOCKERS_HEADING = '\u4e03\u3001\u963b\u585e\u4e0e\u98ce\u9669';
const NEXT_STEPS_HEADING = '\u516b\u3001\u4e0b\u4e00\u6b65\u8ba1\u5212';

export function parseArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--member' || arg === '--date') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else {
      throw new Error(`Unsupported option: ${arg}`);
    }
  }
  return options;
}

export function dateInShanghai(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function timestampInShanghai(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
  }).format(date);
}

export function safeReason(error) {
  const message = String(error?.message ?? error ?? 'Unknown SMTP failure');
  return message
    .replace(/\b([A-Za-z_]*(?:pass|token|secret|authorization)[A-Za-z_]*)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 160);
}

export function canonicalReport(markdown) {
  const mailLog = new RegExp(`\\n## ${MAIL_LOG_HEADING}[\\s\\S]*$`, 'u');
  return markdown
    .replace(/^email(?:Status|ContentHash|SentAt):.*(?:\r?\n)?/gm, '')
    .replace(mailLog, '')
    .trim();
}

export function contentHash(markdown) {
  return crypto.createHash('sha256').update(canonicalReport(markdown), 'utf8').digest('hex');
}

export function frontmatter(markdown, key) {
  return markdown.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

function upsertFrontmatter(markdown, key, value) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error('Report is missing YAML frontmatter.');
  const lines = match[1].split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index >= 0) lines[index] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  return markdown.replace(match[0], `---\n${lines.join('\n')}\n---`);
}

export function updateReport(markdown, { status, hash, timestamp, reason = '' }) {
  let updated = upsertFrontmatter(markdown, 'emailStatus', status);
  updated = upsertFrontmatter(updated, 'emailContentHash', hash);
  updated = upsertFrontmatter(updated, 'emailSentAt', timestamp);
  const statusLabel = status === 'sent' ? '\u53d1\u9001\u6210\u529f' : '\u53d1\u9001\u5931\u8d25';
  const record = [
    `## ${MAIL_LOG_HEADING}`,
    '',
    `- **\u63a5\u6536\u90ae\u7bb1**\uff1a${RECIPIENT}`,
    `- **\u53d1\u9001\u72b6\u6001**\uff1a${statusLabel}`,
    `- **\u53d1\u9001\u65f6\u95f4**\uff1a${timestamp}`,
    `- **\u5931\u8d25\u539f\u56e0**\uff1a${reason}`,
    '',
  ].join('\n');
  const mailLog = new RegExp(`\\n## ${MAIL_LOG_HEADING}[\\s\\S]*$`, 'u');
  return mailLog.test(updated)
    ? updated.replace(mailLog, `\n${record}`)
    : `${updated.trim()}\n\n${record}`;
}

function section(markdown, heading) {
  const pattern = new RegExp(`## ${heading}\\r?\\n+([\\s\\S]*?)(?=\\r?\\n## |$)`, 'u');
  return markdown.match(pattern)?.[1]?.trim() ?? '\u6682\u65e0\u660e\u786e\u8bb0\u5f55\u3002';
}

export function hasBlockers(markdown) {
  const blockers = section(markdown, BLOCKERS_HEADING);
  return !/(?:\u65e0\u660e\u786e(?:\u5f00\u53d1)?\u963b\u585e|\u65e0\u963b\u585e|\u6682\u65e0\u963b\u585e)/u.test(blockers);
}

export function emailBody(markdown, reportPath) {
  const title = `\u6210\u5458${DAILY_REPORT_LABEL}`;
  const fields = [
    ['\u6210\u5458', frontmatter(markdown, 'member')],
    ['\u6a21\u5757', frontmatter(markdown, 'module')],
    ['\u65e5\u671f', frontmatter(markdown, 'date')],
    ['\u4eca\u65e5\u6982\u8ff0', section(markdown, WORK_HEADING)],
    ['\u5b8c\u6210', section(markdown, COMPLETED_HEADING)],
    ['\u672a\u5b8c\u6210', section(markdown, UNFINISHED_HEADING)],
    ['\u963b\u585e\u4e0e\u98ce\u9669', section(markdown, BLOCKERS_HEADING)],
    ['\u4e0b\u4e00\u6b65', section(markdown, NEXT_STEPS_HEADING)],
    ['\u62a5\u544a\u8def\u5f84', reportPath],
  ];
  const text = [title, '', ...fields.flatMap(([label, value]) => [`${label}\uff1a`, value, ''])].join('\n').trim();
  const html = `<p><strong>${title}</strong></p>${fields.map(([label, value]) => `<p><strong>${escapeHtml(label)}\uff1a</strong><br>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`).join('')}`;
  return {
    text,
    html,
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function git(root, ...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function detectMember(root, explicitMember) {
  if (explicitMember) return explicitMember;
  try {
    const config = JSON.parse(await readFile(path.join(root, 'member.config.json'), 'utf8'));
    if (config.memberName) return config.memberName;
  } catch {
    // member.config.json is optional.
  }
  const branch = git(root, 'branch', '--show-current');
  if (/zhangzihong/i.test(branch)) return MEMBER_NAME;
  return process.env.REPORT_MEMBER || git(root, 'config', 'user.name');
}

async function writeLog(root, member, date, status, reason = '') {
  const directory = path.join(root, 'reports', 'logs');
  await mkdir(directory, { recursive: true });
  const line = `[${timestampInShanghai()}] member=${member} date=${date} status=${status} recipient=${RECIPIENT}${reason ? ` reason=${safeReason(reason)}` : ''}\n`;
  await appendFile(path.join(directory, 'member-report-email.log'), line);
}

function requireSmtp() {
  const missing = ['SMTP_USER', 'SMTP_PASS'].filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required SMTP configuration: ${missing.join(', ')}`);
  return {
    host: process.env.SMTP_HOST || 'smtp.163.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  };
}

export async function sendReport({
  root = process.cwd(),
  member,
  date = dateInShanghai(),
  dryRun = false,
  createTransport = nodemailer.createTransport,
  loadEnv = dotenv.config,
  retryDelayMs = RETRY_DELAY_MS,
  smtpConfig,
}) {
  const resolvedMember = await detectMember(root, member);
  if (!resolvedMember) throw new Error('Unable to identify member; pass --member or provide member.config.json.');
  const reportPath = path.join(root, 'reports', 'members', resolvedMember, `${date}.md`);
  const markdown = await readFile(reportPath, 'utf8');
  const hash = contentHash(markdown);
  const previouslySent = frontmatter(markdown, 'emailStatus') === 'sent';
  if (previouslySent && frontmatter(markdown, 'emailContentHash') === hash) {
    return { status: 'skipped', reportPath, member: resolvedMember, date };
  }

  const subjectTag = hasBlockers(markdown) ? '\u5b58\u5728\u963b\u585e' : (previouslySent ? '\u66f4\u65b0\u7248' : '');
  const subject = subjectTag
    ? `\u3010\u6210\u5458${DAILY_REPORT_LABEL}\uff5c${subjectTag}\u3011${resolvedMember} - ${date}`
    : `\u3010\u6210\u5458${DAILY_REPORT_LABEL}\u3011${resolvedMember} - ${date}`;
  if (dryRun) return { status: 'dry-run', reportPath, member: resolvedMember, date, subject, hash };

  loadEnv({ path: path.join(root, '.env') });
  try {
    const smtp = smtpConfig ?? requireSmtp();
    const transport = createTransport(smtp);
    const body = emailBody(markdown, path.relative(root, reportPath));
    let lastError;
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      try {
        await transport.sendMail({
          from: smtp.auth.user,
          to: RECIPIENT,
          subject,
          ...body,
          attachments: [{
            filename: `${resolvedMember}-${DAILY_REPORT_LABEL}-${date}.md`,
            content: markdown,
            contentType: 'text/markdown; charset=utf-8',
          }],
        });
        const timestamp = timestampInShanghai();
        await writeFile(reportPath, updateReport(markdown, { status: 'sent', hash, timestamp }));
        await writeLog(root, resolvedMember, date, 'sent');
        return { status: 'sent', reportPath, member: resolvedMember, date, subject };
      } catch (error) {
        lastError = error;
        if (attempt < RETRIES && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    throw lastError;
  } catch (error) {
    const reason = safeReason(error);
    const timestamp = timestampInShanghai();
    await writeFile(reportPath, updateReport(markdown, { status: 'failed', hash, timestamp, reason }));
    await writeLog(root, resolvedMember, date, 'failed', reason);
    throw new Error(`Daily report was preserved but email was not sent: ${reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await sendReport({ ...parseArgs(process.argv.slice(2)) });
    console.log(`Daily report ${result.status}: ${path.relative(process.cwd(), result.reportPath)}`);
  } catch (error) {
    console.error(safeReason(error));
    process.exitCode = 1;
  }
}
