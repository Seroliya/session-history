#!/usr/bin/env node
// Make the skill visible to DSH, Codex and Claude Code on this machine.
//
//   From a git clone:  links <tool home>/skills/session-history -> the clone.
//   From npx:          the package sits in a temporary npm cache, so it is first
//                      copied to a stable home (~/.session-history, override with
//                      SESSION_HISTORY_HOME) and the tools are linked to that copy.
//
// Links are junctions on Windows (no admin rights needed), symlinks elsewhere.
// Options: --copy (copy into each tool instead of linking), --force (replace
// existing entries), --dry-run, --uninstall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'session-history';
const MARKER = '.installed-copy';
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function toolHomes() {
  const home = os.homedir();
  return [
    ['DSH', process.env.DSH_HOME || path.join(home, '.dsh')],
    ['Codex', process.env.CODEX_HOME || path.join(home, '.codex')],
    ['Claude Code', process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')],
  ];
}

const stableHome = () => path.resolve(process.env.SESSION_HISTORY_HOME || path.join(os.homedir(), '.session-history'));
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => fs.existsSync(p) || isLink(p);
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// Remove a link without ever following it into its target.
function removeEntry(p) {
  if (isLink(p)) {
    try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
  } else {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function isTransient(dir) {
  const d = dir.replace(/\\/g, '/').toLowerCase();
  return d.includes('/_npx/') || d.includes('/npm-cache/') || d.startsWith(os.tmpdir().replace(/\\/g, '/').toLowerCase() + '/');
}

function copyPackage(from, to) {
  const skip = new Set(['.git', 'node_modules']);
  fs.cpSync(from, to, { recursive: true, filter: (p) => !path.relative(from, p).split(/[\\/]/).some((seg) => skip.has(seg)) });
}

export function install(argv = []) {
  const args = new Set(argv);
  const copy = args.has('--copy'), force = args.has('--force'), dry = args.has('--dry-run');
  const say = (s) => console.log((dry ? '[dry-run] ' : '') + s);

  // 1. Decide which directory the tools should point at.
  let source = PKG_DIR;
  if (isTransient(PKG_DIR)) {
    const home = stableHome();
    if (exists(home) && fs.existsSync(path.join(home, '.git'))) {
      throw new Error(`${home} 是一个 git 仓库，请在其中用 git pull 更新，或设置 SESSION_HISTORY_HOME 到别处`);
    }
    if (exists(home) && !fs.existsSync(path.join(home, MARKER)) && !force) {
      throw new Error(`${home} 已存在且不是由本安装程序创建的，加 --force 覆盖或设置 SESSION_HISTORY_HOME`);
    }
    say(`复制到固定位置 ${home}`);
    if (!dry) {
      if (exists(home)) removeEntry(home);
      copyPackage(PKG_DIR, home);
      fs.writeFileSync(path.join(home, MARKER), `installed ${new Date().toISOString()} from npx\n`);
    }
    source = home;
  }

  // 2. Link (or copy) into each installed tool.
  let installed = 0;
  for (const [tool, toolHome] of toolHomes()) {
    if (!fs.existsSync(toolHome)) { say(`${tool}: 未安装（${toolHome} 不存在），跳过`); continue; }
    const dest = path.join(toolHome, 'skills', NAME);
    const real = realOf(dest);
    if (real && same(real, source)) { say(`${tool}: 已就绪 ${dest}`); installed++; continue; }
    if (exists(dest)) {
      if (same(dest, source)) { say(`${tool}: ${dest} 就是本仓库，已就绪`); installed++; continue; }
      // Only entries this installer made (a link, or a copy carrying the marker)
      // are replaced automatically; a plain directory may be someone's checkout.
      const ours = isLink(dest) || fs.existsSync(path.join(dest, MARKER));
      if (!ours && !force) { say(`${tool}: ${dest} 已存在且不是本安装程序创建的，跳过（--force 替换）`); continue; }
      if (!dry) removeEntry(dest);
    }
    if (!dry) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (copy) {
        copyPackage(source, dest);
        fs.writeFileSync(path.join(dest, MARKER), `copied ${new Date().toISOString()}\n`);
      } else {
        fs.symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    say(`${tool}: 已${copy ? '复制' : '链接'} ${dest}${copy ? '' : ' -> ' + source}`);
    installed++;
  }
  if (!installed) say('没有找到 DSH / Codex / Claude Code 的配置目录。可用 DSH_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR 指定后重试。');
  else {
    say('');
    say('完成。在 agent 里直接说，例如：「找一下我上次在 codex 里做 xx 的会话，进行到哪一步了」。');
    say(`命令行自检：node "${path.join(source, 'scripts', 'sessions.mjs')}" roots`);
  }
}

export function uninstall(argv = []) {
  const dry = argv.includes('--dry-run');
  const say = (s) => console.log((dry ? '[dry-run] ' : '') + s);
  for (const [tool, toolHome] of toolHomes()) {
    const dest = path.join(toolHome, 'skills', NAME);
    if (!exists(dest)) continue;
    if (isLink(dest) || fs.existsSync(path.join(dest, MARKER))) {
      if (!dry) removeEntry(dest);
      say(`${tool}: 已移除 ${dest}`);
    } else {
      say(`${tool}: ${dest} 是普通目录（可能是源码仓库），未删除`);
    }
  }
  const home = stableHome();
  if (fs.existsSync(path.join(home, MARKER))) {
    if (!dry) removeEntry(home);
    say(`已移除 ${home}`);
  }
  say('缓存目录可手动删除：Windows %LOCALAPPDATA%\\session-history，其他系统 ~/.cache/session-history');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--uninstall')) uninstall(argv); else install(argv);
  } catch (e) {
    console.error('安装失败：' + e.message);
    process.exit(1);
  }
}
