// Sandbox test for install/uninstall: simulates an npx run from a temporary
// package cache, with every tool home and the stable home under a temp dir.
// Nothing outside the sandbox is touched. Run: node tests/install-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-install-'));
const npxPkg = path.join(box, '_npx', 'pkg');
fs.cpSync(repo, npxPkg, { recursive: true, filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) });
const env = {
  ...process.env,
  DSH_HOME: path.join(box, 'dsh'), CODEX_HOME: path.join(box, 'codex'), CLAUDE_CONFIG_DIR: path.join(box, 'claude'),
  SESSION_HISTORY_HOME: path.join(box, 'stable'), SESSION_HISTORY_CACHE: path.join(box, 'cache'),
};
fs.mkdirSync(env.DSH_HOME); fs.mkdirSync(env.CODEX_HOME); // Claude Code "not installed"
const cli = (...a) => execFileSync(process.execPath, [path.join(npxPkg, 'scripts', 'cli.mjs'), ...a], { encoding: 'utf8', env });

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

const out1 = cli('install');
const dshLink = path.join(env.DSH_HOME, 'skills', 'session-history');
const codexLink = path.join(env.CODEX_HOME, 'skills', 'session-history');
check('复制到固定位置', fs.existsSync(path.join(env.SESSION_HISTORY_HOME, 'SKILL.md')));
check('不复制 .git', !fs.existsSync(path.join(env.SESSION_HISTORY_HOME, '.git')));
check('DSH 链接指向固定位置', real(dshLink) === real(env.SESSION_HISTORY_HOME));
check('Codex 链接指向固定位置', real(codexLink) === real(env.SESSION_HISTORY_HOME));
check('未安装的工具被跳过', !fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills')) && out1.includes('Claude Code: 未安装'));

const out2 = cli('install');
check('重复安装幂等', (out2.match(/已就绪/g) || []).length === 2);

const roots = execFileSync(process.execPath, [path.join(dshLink, 'scripts', 'sessions.mjs'), 'roots'], { encoding: 'utf8', env });
check('经由链接可运行', roots.includes('# 会话目录'));
const viaCli = cli('roots');
check('cli 转发普通命令', viaCli.includes('# 会话目录'));

// A plain directory someone placed there must survive without --force.
fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
const userDir = path.join(env.CLAUDE_CONFIG_DIR, 'skills', 'session-history');
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(path.join(userDir, 'keep.txt'), 'x');
const out3 = cli('install');
check('已有普通目录时跳过', fs.existsSync(path.join(userDir, 'keep.txt')) && out3.includes('跳过'));
cli('install', '--force');
check('--force 替换为链接', real(userDir) === real(env.SESSION_HISTORY_HOME));

cli('uninstall');
check('卸载移除链接', !fs.existsSync(dshLink) && !fs.existsSync(codexLink) && !fs.existsSync(userDir));
check('卸载移除固定位置副本', !fs.existsSync(env.SESSION_HISTORY_HOME));
check('卸载不删除源包', fs.existsSync(path.join(npxPkg, 'SKILL.md')));

fs.rmSync(box, { recursive: true, force: true });
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
