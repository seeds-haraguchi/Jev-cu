#!/usr/bin/env node
/**
 * プロジェクトの skill/jev-use を Codex のスキルディレクトリへインストールする。
 *
 *   node scripts/install-skill.mjs            # コピーしてインストール（デフォルト、安定）
 *   node scripts/install-skill.mjs --link     # シンボリックリンクでインストール（常にプロジェクトを参照）
 *   node scripts/install-skill.mjs --uninstall # アンインストール
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PROJECT_DIR, "skill", "jev-use");
const DEST = path.join(os.homedir(), ".codex", "skills", "jev-use");
const REPO_DIR_PLACEHOLDER = "{{REPO_DIR}}";
const uninstall = process.argv.includes("--uninstall");
const link = process.argv.includes("--link");

/** スキル本文の {{REPO_DIR}} をローカルのプロジェクトパスへ置き換える（コピー時に実行）。 */
function materializeRepoDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) materializeRepoDir(p);
    else if (entry.isFile()) {
      const text = fs.readFileSync(p, "utf8");
      const replaced = text.split(REPO_DIR_PLACEHOLDER).join(PROJECT_DIR);
      if (replaced !== text) fs.writeFileSync(p, replaced);
    }
  }
}

if (uninstall) {
  fs.rmSync(DEST, { recursive: true, force: true });
  console.log(`アンインストールしました：${DEST}`);
  process.exit(0);
}

if (!fs.existsSync(path.join(SRC, "SKILL.md"))) {
  console.error(`スキルのソースがありません：${SRC}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.rmSync(DEST, { recursive: true, force: true });
if (link) {
  fs.symlinkSync(SRC, DEST, "dir");
  console.log(`シンボリックリンクでインストールしました：${DEST} → ${SRC}`);
} else {
  fs.cpSync(SRC, DEST, { recursive: true });
  materializeRepoDir(DEST);
  console.log(`コピーしてインストールしました：${SRC} → ${DEST}`);
}
console.log("新しいセッションで有効になります。アンインストール：node scripts/install-skill.mjs --uninstall");
