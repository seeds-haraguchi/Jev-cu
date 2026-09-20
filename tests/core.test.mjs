import test from "node:test";
import assert from "node:assert/strict";
import { parseAX, selectCandidates, buildContext } from "../scripts/loop.mjs";
import { evaluatePolicy, matchSensitive } from "../scripts/policy.mjs";
import { buildQuestions, normalizeDecision, sanitizeLabel } from "../scripts/jev-decide.mjs";

const CALENDAR_AX = [
  'Window: "Calendar", App: Calendar.',
  '0 standard window Calendar, ID: CALMainWindow, Secondary Actions: Raise',
  "\t1 split group",
  "\t\t2 container Description: Month Calendar Area, Value: 9/18/26, ID: active-view",
  "\t\t\t4 list Sunday, August 30",
  "\t\t\t5 list Monday, August 31",
  "\t\t\t6 list Tuesday, September 1",
  "\t\t\t7 list Wednesday, September 2",
  "\t\t\t8 list Thursday, September 3",
  "\t\t\t9 list Friday, September 4",
  "\t\t\t10 list Saturday, September 5",
  "\t\t\t11 list Sunday, September 6",
  "\t\t\t12 list Monday, September 7",
  "\t\t\t13 Event Description: Labor Day. September 7, 2026, All-Day",
  "\t17 list Tuesday, September 8",
  "\t24 list Sunday, September 13",
  "\t31 list Today, Friday, September 18",
  "\t\t\t56 button previous month",
  "\t\t\t57 button Today, ID: today-button",
  "\t\t\t58 button next month",
  "\t\t59 text Value: September 2026, ID: view-date-title",
  "\t60 toolbar",
  "\t\t64 button Description: Add Event",
  "\t\t71 button Search",
  "\t72 close button",
  "The focused UI element is 2 container Description: Month Calendar Area",
].join("\n");

test("parseAX はインデックス・ロール・ラベルを解析する", () => {
  const els = parseAX(CALENDAR_AX);
  const prev = els.find((e) => e.index === 56);
  assert.equal(prev.role, "button");
  assert.equal(prev.label, "previous month");
  const field = els.find((e) => e.index === 57);
  assert.equal(field.role, "button");
});

test("selectCandidates は対象ボタンを候補から押し出さない（P0 実測回帰）", () => {
  const els = parseAX(CALENDAR_AX);
  const candidates = selectCandidates(els, "switch the calendar to the previous month", { max: 40 });
  const indices = candidates.map((c) => c.index);
  assert.ok(indices.includes(56), "previous month ボタンが候補に必要");
  assert.ok(indices.includes(58), "next month ボタンが候補に必要");
  // カレンダーの日付セルも選択できる。月移動ボタンは無関係な日付より前に置く。
  assert.ok(indices.indexOf(56) < indices.indexOf(4));
});

test("selectCandidates は max が小さくてもボタンを優先して残す", () => {
  const els = parseAX(CALENDAR_AX);
  const candidates = selectCandidates(els, "previous month", { max: 3 });
  assert.ok(candidates.map((c) => c.index).includes(56));
});

test("selectCandidates は日本語の検索ラベルを候補に含める", () => {
  const candidates = selectCandidates(parseAX('0 button 検索'), "検索を開く", { max: 3 });
  assert.equal(candidates[0].label, "検索");
});

test("buildContext は少量のコンテキストだけを取得する", () => {
  const ctx = buildContext(CALENDAR_AX);
  assert.ok(ctx.includes("Calendar"));
  assert.ok(ctx.includes("September 2026"), "重要なテキスト状態（現在の月）を含む必要がある");
  assert.ok(ctx.split("\n").length <= 9);
});

test("buildContext は電卓の表示値を含める", () => {
  const calcAx = ['Window: "Calculator", App: Calculator.', '0 standard window Calculator', '\t4 text ‎42', '\t24 button Equals'].join("\n");
  const ctx = buildContext(calcAx);
  assert.ok(ctx.includes("42"), "Jev が現在の表示値を見られる必要がある");
});

test("policy：完了確率が高い → done", () => {
  const gate = evaluatePolicy({ decision: { done: 0.95, confidence: 1, targetIndex: 56 }, app: "Calendar" });
  assert.equal(gate.verdict, "done");
});

test("policy：敏感な対象 → confirm", () => {
  const gate = evaluatePolicy({
    decision: { done: 0.01, risk: 0.01, confidence: 0.99, targetIndex: 12, targetLabel: "button 删除歌曲" },
    app: "NetEaseMusic",
  });
  assert.equal(gate.verdict, "confirm");
});

test("policy：高リスク判定 → confirm", () => {
  const gate = evaluatePolicy({
    decision: { done: 0.01, risk: 0.8, confidence: 0.99, targetIndex: 12, targetLabel: "button download" },
    app: "NetEaseMusic",
  });
  assert.equal(gate.verdict, "confirm");
});

test("policy：低信頼度を stop / escalate に分ける", () => {
  const stop = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.2, targetIndex: 1 }, app: "Calendar" });
  assert.equal(stop.verdict, "stop");
  // Calendar は副作用のない App（下限 0.4）のため、0.35 でもエスカレーションする。
  const esc = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.35, targetIndex: 1 }, app: "Calendar" });
  assert.equal(esc.verdict, "escalate");
  // 副作用のある App（下限 0.5）のため、0.45 でもエスカレーションする。
  const esc2 = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.45, targetIndex: 1 }, app: "NetEaseMusic" });
  assert.equal(esc2.verdict, "escalate");
});

test("policy：副作用のない App は信頼度 0.46 で通し、他の App はエスカレーションする", () => {
  const calc = evaluatePolicy({ decision: { done: 0.1, risk: 0.03, confidence: 0.46, targetIndex: 24, targetLabel: "button: Equals" }, app: "Calculator" });
  assert.equal(calc.verdict, "proceed");
  const netease = evaluatePolicy({ decision: { done: 0.1, risk: 0.03, confidence: 0.46, targetIndex: 24, targetLabel: "link: 播放" }, app: "NetEaseMusic" });
  assert.equal(netease.verdict, "escalate");
});

test("policy：許可リスト外の App → confirm", () => {
  const gate = evaluatePolicy({ decision: { done: 0.1, risk: 0, confidence: 1, targetIndex: 1 }, app: "UnknownApp" });
  assert.equal(gate.verdict, "confirm");
});

test("matchSensitive は支払いと送信に一致する", () => {
  assert.equal(matchSensitive("button 立即支付").id, "payment");
  assert.equal(matchSensitive("button Send message").id, "send");
  assert.equal(matchSensitive("button 支払いを確定").id, "payment");
  assert.equal(matchSensitive("button メッセージを送信").id, "send");
  assert.equal(matchSensitive("button Search"), null);
});

test("buildQuestions/normalizeDecision の往復は一致する", () => {
  const candidates = [
    { index: 56, role: "button", label: "previous month" },
    { index: 58, role: "button", label: "next month" },
  ];
  const { questions, criteria } = buildQuestions("go to the previous month", candidates);
  assert.ok(questions.target.criteria.i56.includes("previous month"));
  assert.ok(questions.action.criteria.drag, "操作種別に drag が含まれる必要がある");
  const decision = normalizeDecision(
    {
      target: { choice: "i56", confidence: 1, probabilities: { i56: 1, i58: 0 } },
      action: { choice: "click_element" },
      done: { noul: 0.04 },
      risk: { noul: 0.01 },
    },
    criteria,
  );
  assert.equal(decision.targetIndex, 56);
  assert.equal(decision.action, "click_element");
  assert.equal(decision.done, 0.04);
});

test("sanitizeLabel は長い URL を除去して長さを制限する", () => {
  const raw = "link: 下载管理, Value: orpheus://orpheus/pub/app.html?resizable=true&x=0&y=0&width=1470#/m/offline/complete/";
  const clean = sanitizeLabel(raw);
  assert.ok(!clean.includes("orpheus://"));
  assert.ok(clean.includes("下载管理"));
  assert.ok(clean.length <= 120);
});

// 実行境界の回帰：すべてモック driver を使い、実際の App を操作せず、ネットワークも呼び出さない。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTask } from "../scripts/loop.mjs";

async function mockRun(options) {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  try {
    return await runTask({ appName: "Calendar", goal: "next month", emit: () => {}, traceDir, ...options });
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
}

test("Planner のプレビューは操作せず、実行は引き継ぎへ渡す", async () => {
  let actions = 0;
  const driver = { bind: async () => {}, observe: async () => CALENDAR_AX, typeText: async () => { actions++; } };
  for (const dryRun of [true, false]) {
    const result = await mockRun({ driver, dryRun, maxSteps: 1, resources: () => ({ skipJev: true, action: "type_text", text: "test" }) });
    assert.equal(result.status, dryRun ? "dry_run" : "escalate");
  }
  assert.equal(actions, 0);
});

test("完了は最終状態で検証し、最後のステップ後にも確認する", async () => {
  let ax = CALENDAR_AX;
  const observations = [];
  const driver = {
    bind: async () => {},
    observe: async ({ full }) => { observations.push(full); return ax; },
    click: async () => { ax = ax.replace("September 2026", "October 2026"); },
  };
  const result = await mockRun({ driver, dryRun: false, maxSteps: 1,
    decide: async () => ({ action: "click_element", targetIndex: 58, targetLabel: "next month", confidence: 1, risk: 0, done: 0 }),
    verify: text => text.includes("October 2026"),
  });
  assert.equal(result.status, "done");
  assert.equal(result.verified, true);
  assert.deepEqual(observations, [true, true]);
});

test("Jev 自身の完了報告で失敗した結果検証を上書きできない", async () => {
  const result = await mockRun({ driver: { bind: async () => {}, observe: async () => CALENDAR_AX },
    dryRun: false, maxSteps: 1, verify: () => false,
    decide: async () => ({ done: 0.99, confidence: 1 }),
  });
  assert.equal(result.status, "escalate");
});

test("未知の対象や不足した確率は通さない", () => {
  const decision = normalizeDecision({ target: { choice: "i999" }, action: { choice: "click_element" } }, { i1: "button A" });
  assert.equal(decision.targetIndex, null);
  assert.equal(evaluatePolicy({ decision, app: "Calendar" }).verdict, "escalate");
});
