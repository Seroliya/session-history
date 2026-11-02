#!/usr/bin/env node
// Package entry (npx github:Seroliya/session-history <command>):
//   install / uninstall   set up the skill for DSH, Codex and Claude Code
//   anything else         forwarded to sessions.mjs (list, search, show, ...)
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'install' || cmd === 'uninstall') {
  const { install, uninstall } = await import('./install.mjs');
  try {
    (cmd === 'install' ? install : uninstall)(rest);
  } catch (e) {
    console.error('安装失败：' + e.message);
    process.exit(1);
  }
} else {
  await import('./sessions.mjs');
}
