// Locate session stores. Priority per source:
//   1. --root <src>=<path>          (overrides all other roots for that source)
//   2. SESSION_HISTORY_ROOTS        "dsh=D:\x;codex=/y" or bare paths (sniffed), additive
//   3. tool env vars                DSH_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR
//   4. config.json                  {"roots": {"dsh": [...], "codex": [...], "claude": [...]}, "extraRoots": [...]}
//   5. default                      ~/.dsh  ~/.codex  ~/.claude
//   6. probe (only when nothing above exists): XDG_DATA_HOME, %APPDATA%, WSL /mnt/c/Users/*
import fs from 'node:fs';
import path from 'node:path';
import { HOME, loadConfig, normPath } from './util.mjs';

export const SOURCES = ['dsh', 'codex', 'claude'];
const DIRNAME = { dsh: '.dsh', codex: '.codex', claude: '.claude' };
const ENV = { dsh: 'DSH_HOME', codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR' };

function expand(p) {
  if (!p) return p;
  let s = String(p).trim().replace(/^~(?=$|[\\/])/, HOME);
  s = s.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m).replace(/\$\{?(\w+)\}?/g, (m, k) => process.env[k] ?? m);
  return path.resolve(s);
}

// Guess which tool a directory belongs to by its contents.
export function sniffRoot(dir) {
  const has = (...p) => fs.existsSync(path.join(dir, ...p));
  if (has('session_index.jsonl') || has('archived_sessions')) return 'codex';
  if (has('projects')) return 'claude';
  if (has('sessions')) {
    try {
      const first = fs.readdirSync(path.join(dir, 'sessions'))[0] || '';
      if (/^\d{4}$/.test(first)) return 'codex';
      return 'dsh';
    } catch { return null; }
  }
  // Maybe the directory IS a sessions/projects dir: look for characteristic files.
  let found = null;
  (function walk(d, depth) {
    if (found || depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found) return;
      if (e.isFile()) {
        if (/^session(?:\.v\d+)?\.jsonl\.zstd?$/.test(e.name)) found = 'dsh';
        else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) found = 'codex';
        else if (/^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(e.name)) found = 'claude';
      }
    }
    for (const e of ents) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
  })(dir, 0);
  return found;
}

function parseSpec(spec) {
  const m = /^(dsh|codex|claude)=(.+)$/i.exec(String(spec).trim());
  return m ? { src: m[1].toLowerCase(), p: m[2] } : { src: null, p: spec };
}

function wslUserDirs() {
  try {
    if (process.platform !== 'linux') return [];
    if (!/microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))) return [];
    return fs.readdirSync('/mnt/c/Users').map((u) => path.join('/mnt/c/Users', u));
  } catch { return []; }
}

export function resolveRoots(cliRoots = []) {
  const res = Object.fromEntries(SOURCES.map((s) => [s, []]));
  const notes = [];
  const add = (src, p, via) => {
    if (!src || !p) return;
    const full = expand(p);
    if (!res[src].some((r) => normPath(r.path) === normPath(full))) res[src].push({ path: full, via, exists: fs.existsSync(full) });
  };
  const addSniffed = (p, via) => {
    const full = expand(p);
    if (!fs.existsSync(full)) { notes.push(`${via}: 路径不存在 ${full}`); return; }
    const src = sniffRoot(full);
    if (src) add(src, full, via); else notes.push(`${via}: 无法识别格式 ${full}`);
  };

  const override = new Set();
  for (const spec of cliRoots) {
    const { src, p } = parseSpec(spec);
    if (src) { if (!override.has(src)) { res[src] = []; override.add(src); } add(src, p, '--root'); }
    else {
      const full = expand(p);
      const s = fs.existsSync(full) ? sniffRoot(full) : null;
      if (!s) { notes.push(`--root: 无法识别 ${full}`); continue; }
      if (!override.has(s)) { res[s] = []; override.add(s); }
      add(s, full, '--root');
    }
  }
  // ';' separated on every platform (':' would clash with Windows drive letters).
  const envSpecs = (process.env.SESSION_HISTORY_ROOTS || '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  let cfg = { data: {} };
  try { cfg = loadConfig(); } catch (e) { notes.push(e.message); }
  const cfgRoots = cfg.data.roots || {};

  for (const src of SOURCES) {
    if (override.has(src)) continue;
    for (const spec of envSpecs) {
      const { src: s, p } = parseSpec(spec);
      if (s === src) add(src, p, 'SESSION_HISTORY_ROOTS');
    }
    if (process.env[ENV[src]]) add(src, process.env[ENV[src]], ENV[src]);
    for (const p of [].concat(cfgRoots[src] || [])) add(src, p, 'config');
    add(src, path.join(HOME, DIRNAME[src]), 'default');
  }
  for (const spec of envSpecs) if (!parseSpec(spec).src) addSniffed(spec, 'SESSION_HISTORY_ROOTS');
  for (const p of [].concat(cfg.data.extraRoots || [])) addSniffed(p, 'config.extraRoots');

  for (const src of SOURCES) {
    if (override.has(src) || res[src].some((r) => r.exists)) continue;
    const cands = [];
    if (process.env.XDG_DATA_HOME) cands.push(path.join(process.env.XDG_DATA_HOME, DIRNAME[src].slice(1)));
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, DIRNAME[src].slice(1)));
    for (const u of wslUserDirs()) cands.push(path.join(u, DIRNAME[src]));
    for (const c of cands) if (fs.existsSync(c) && sniffRoot(c) === src) add(src, c, 'probe');
  }
  for (const src of SOURCES) res[src] = res[src].filter((r) => r.exists || r.via !== 'default');
  return { roots: res, notes, configPath: cfg.path, configExists: !!cfg.exists };
}
