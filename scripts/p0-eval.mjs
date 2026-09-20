#!/usr/bin/env node
/**
 * P0 オフライン評価：保存した AX スナップショットと期待要素のラベルから、Jev の要素選択精度を測定する。
 *
 * ケースファイル fixtures/p0/cases.json：
 *   [{ "name": "...", "app": "Calendar", "goal": "...", "axFile": "fixtures/ax/calendar-month.txt",
 *      "expectedIndex": 56, "expectedLabelIncludes": "previous month" }]
 *
 * 使用方法：
 *   node scripts/p0-eval.mjs            # すべてのケースを実行
 *   node scripts/p0-eval.mjs --limit 3  # 先頭 3 ケースだけ実行
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAX, selectCandidates, buildContext } from "./loop.mjs";
import { decide } from "./jev-decide.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = path.join(PROJECT_DIR, "fixtures", "p0", "cases.json");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8")).slice(0, limit);
if (!cases.length) {
  console.error("ケースがありません。fixtures/p0/cases.json を先に記入してください");
  process.exit(1);
}

const rows = [];
for (const c of cases) {
  const axPath = path.join(PROJECT_DIR, c.axFile);
  const ax = fs.readFileSync(axPath, "utf8");
  const candidates = selectCandidates(parseAX(ax), c.goal, { max: c.max ?? 40 });
  let decision;
  let error = null;
  try {
    decision = await decide({
      goal: c.goal,
      app: c.app,
      candidates,
      context: buildContext(ax),
      constraints: c.constraints ?? "",
    });
  } catch (err) {
    error = err.message;
  }

  const hit =
    !error &&
    (c.expectedIndex != null
      ? decision.targetIndex === c.expectedIndex
      : String(decision.targetLabel ?? "").includes(c.expectedLabelIncludes ?? "\u0000"));

  rows.push({
    name: c.name,
    expected: c.expectedIndex ?? c.expectedLabelIncludes ?? "?",
    got: error ? `ERR ${error}` : `i${decision.targetIndex} ${decision.targetLabel ?? ""}`,
    hit,
    conf: decision?.confidence ?? null,
    ms: decision?.latencyMs ?? null,
    tokens: decision?.usage?.input_tokens ?? decision?.usage?.inputTokens ?? null,
    cost: decision?.costUsd ?? null,
    candidates: candidates.length,
  });
  console.log(
    `${hit ? "✅" : "❌"} ${c.name.padEnd(28)} 期待=${String(rows.at(-1).expected).padEnd(18)} 結果=${rows.at(-1).got}` +
      (error ? "" : `  conf=${rows.at(-1).conf?.toFixed?.(2) ?? "n/a"} ${rows.at(-1).ms}ms ${rows.at(-1).tokens}tok`),
  );
}

const ok = rows.filter((r) => r.hit);
const lat = rows.map((r) => r.ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
const tokens = rows.reduce((a, r) => a + (r.tokens ?? 0), 0);
const cost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : null;

console.log(
    `\n精度 ${ok.length}/${rows.length}` +
    ` · p50 ${p50 ?? "n/a"}ms` +
    ` · トークン ${tokens}` +
    ` · 費用 ≈ $${cost.toFixed(6)}`,
);

const reportDir = path.join(PROJECT_DIR, "runs");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `p0-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), accuracy: `${ok.length}/${rows.length}`, p50Ms: p50, tokens, costUsd: cost, rows }, null, 2));
console.log(`レポート：${reportPath}`);
