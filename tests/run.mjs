// Self-test: builds a synthetic Claude Code store (no real data exists on the
// authoring machine) and checks branch handling, compaction, subagents,
// actions and redaction through the CLI. Run: node tests/run.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'scripts', 'sessions.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-test-'));
const SID = '11111111-2222-4333-8444-555555555555';
const proj = path.join(root, 'projects', '-C-work-demo');
fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });

let t = Date.parse('2026-10-01T10:00:00Z');
const base = (uuid, parentUuid, extra) => ({ uuid, parentUuid, sessionId: SID, cwd: 'C:\\work\\demo', timestamp: new Date(t += 1000).toISOString(), isSidechain: false, ...extra });
const user = (uuid, p, content, extra = {}) => base(uuid, p, { type: 'user', message: { role: 'user', content }, ...extra });
const asst = (uuid, p, content) => base(uuid, p, { type: 'assistant', message: { role: 'assistant', model: 'claude-test', content, usage: { input_tokens: 10, output_tokens: 5 } } });

const recs = [
  { type: 'ai-title', aiTitle: '合成测试会话', sessionId: SID },
  user('u1', null, '帮我修复 demo.py 的 bug，api_key=sk-test1234567890abcdefXYZ'),
  asst('a1', 'u1', [{ type: 'thinking', thinking: '先看看文件', signature: 'x' }, { type: 'text', text: '我先运行测试。' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pytest -q' } }]),
  user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 'tu1', content: '1 failed', is_error: true }]),
  asst('a2', 'r1', [{ type: 'text', text: '测试失败，原因是除零。' }]),
  user('u2', 'a2', '旧分支：改用方案A'),
  asst('a3', 'u2', [{ type: 'text', text: '旧分支回复-不应出现' }]),
  user('u2b', 'a2', '新分支：改用方案B'),
  { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'u2b', sessionId: SID, timestamp: new Date(t += 1000).toISOString(), content: 'Conversation compacted' },
  user('cs', 'c1', 'This session is being continued... 摘要：用户要修 demo.py，选了方案B。', { isCompactSummary: true }),
  user('u3', 'cs', '继续，按方案B改'),
  asst('a4', 'u3', [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'C:\\work\\demo\\demo.py', old_string: 'a/b', new_string: 'a/b if b else 0' } }, { type: 'tool_use', id: 'tu3', name: 'Task', input: { description: '写测试', prompt: '为 demo.py 写测试' } }]),
  user('r2', 'a4', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }]),
  { ...asst('s1', 'r2', [{ type: 'text', text: 'sidechain 内容-不应出现' }]), isSidechain: true },
  user('r3', 'r2', [{ type: 'tool_result', tool_use_id: 'tu3', content: '子代理完成' }]),
  asst('a5', 'r3', [{ type: 'text', text: '已按方案B修复并补了测试。' }, { type: 'tool_use', id: 'tu4', name: 'TodoWrite', input: { todos: [{ content: '修复除零', status: 'completed' }, { content: '发布', status: 'pending' }] } }]),
];
fs.writeFileSync(path.join(proj, SID + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-abc123.jsonl'), [
  { ...user('x1', null, '为 demo.py 写测试'), isSidechain: true, agentId: 'abc123' },
  { ...asst('x2', 'x1', [{ type: 'text', text: '测试已写好' }]), isSidechain: true, agentId: 'abc123' },
].map((r) => JSON.stringify(r)).join('\n'));
fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-abc123.meta.json'), JSON.stringify({ description: '写测试', toolUseId: 'tu3' }));

// Hermetic: dsh/codex point at empty dirs so real sessions on this machine are never parsed.
const empty = path.join(root, 'empty');
fs.mkdirSync(empty);
const run = (...args) => execFileSync(process.execPath, [cli, '--root', `claude=${root}`, '--root', `dsh=${empty}`, '--root', `codex=${empty}`, '--no-cache', ...args], { encoding: 'utf8', env: { ...process.env, SESSION_HISTORY_CURRENT: 'none' } });
let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

const list = run('list', '--source', 'claude');
check('list 显示标题', list.includes('合成测试会话'));
check('list 默认隐藏子代理', !list.includes('agent-abc123'));

const full = run('show', '11111111', '--view', 'full', '--budget', '0');
check('丢弃被编辑掉的旧分支', !full.includes('旧分支回复-不应出现') && !full.includes('旧分支：改用方案A'));
check('保留新分支', full.includes('新分支：改用方案B'));
check('头部报告丢弃的分支消息', /已忽略 2 条/.test(full));
check('跨越 compact 边界继续', full.includes('继续，按方案B改') && full.includes('帮我修复 demo.py'));
check('compact 摘要被标注', full.includes('compact 摘要') && full.includes('摘要：用户要修'));
check('sidechain 不混入主线', !full.includes('sidechain 内容-不应出现'));
check('thinking 在 full 视图可见', full.includes('思考: 先看看文件'));
check('工具错误被标出', /← Bash \[错误\]/.test(full));
check('子会话被列出', full.includes('写测试') && full.includes('子会话 1 个'));
check('默认脱敏', !full.includes('sk-test1234567890') && full.includes('sk-[REDACTED]'));
check('待办读取', full.includes('完成 1/2'));

const chat = run('show', '11111111');
check('chat 视图隐藏工具调用', !chat.includes('→ Bash'));
const since = run('show', '11111111', '--since-compact');
check('--since-compact 从摘要开始', since.includes('摘要：用户要修') && !since.includes('帮我修复 demo.py 的 bug'));

const acts = run('actions', '11111111');
check('actions 提取命令', acts.includes('$ pytest -q') && acts.includes('[错误]'));
check('actions 提取改动文件', acts.includes('demo.py') && acts.includes('[edit]'));

const sub = run('show', 'agent-abc');
check('可直接读取子代理会话', sub.includes('测试已写好'));

const hits = run('search', '方案B', '--source', 'claude');
check('search 命中且不含旧分支', hits.includes('方案B') && !hits.includes('方案A'));

// A later session in the same cwd is reported as possible follow-up work.
const SID2 = '22222222-2222-4333-8444-555555555555';
t = Date.parse('2026-10-05T10:00:00Z');
fs.writeFileSync(path.join(proj, SID2 + '.jsonl'), [
  { ...user('v1', null, '接着上次 demo.py 的工作，发布新版本'), sessionId: SID2 },
  { ...asst('v2', 'v1', [{ type: 'text', text: '已发布 v1.1' }]), sessionId: SID2 },
].map((r) => JSON.stringify(r)).join('\n'));
const rel = run('show', '11111111', '--budget', '500');
check('提示同目录之后的会话', rel.includes('同目录之后的会话') && rel.includes('22222222'));

const ho = run('handoff', '11111111');
check('handoff 有最初请求与最后状态', ho.includes('## 最初请求') && ho.includes('已按方案B修复'));

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
