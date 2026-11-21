#!/usr/bin/env node
// Opens the pilot tasks as GitHub issues (needs the GitHub CLI `gh`, logged in, and the repo name).
//   node tools/open-tasks.mjs <owner/repo> [--dry]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [repo, flag] = process.argv.slice(2);
if (!repo) { console.error('usage: node tools/open-tasks.mjs <owner/repo> [--dry]'); process.exit(1); }
const tasks = JSON.parse(readFileSync(new URL('../tasks/pilot-tasks.json', import.meta.url), 'utf8'));
for (const t of tasks) {
  const body = `**Bounty: ${t.bounty} RESET** (paid when merged, see CONTRIBUTING.md)\n\n**Done when:** ${t.done}\n\n` +
    `**How:** follow SKILL.md. Claim by commenting \`claim trac1<your payout address>\`. 48 hours to open a pull request.`;
  const args = ['issue', 'create', '--repo', repo, '--title', t.title, '--body', body, '--label', 'bounty', '--label', 'open', '--label', t.type];
  if (flag === '--dry') { console.log('would open:', t.title, `(${t.bounty} RESET)`); continue; }
  console.log(execFileSync('gh', args, { encoding: 'utf8' }).trim());
}
