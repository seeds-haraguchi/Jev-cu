/**
 * jev-use ループエンジン：観測（Computer Use）→ 意思決定（Jev）→ ゲート（Policy）→ 実行（Computer Use）。
 *
 * 設計上の制約：Codex デスクトップアプリの cua_repl JS ランタイムで実行する必要がある（そこにはグローバル `cua` がある）。
 * このモジュール自体は cua 専用 API を import せず、driver アダプターを注入して単体テストできるようにする。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide as jevDecide } from "./jev-decide.mjs";
import { evaluatePolicy, DEFAULT_ALLOWED_APPS } from "./policy.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* --------------------------- AX の解析と候補 --------------------------- */

const ROLES = [
  "standard window",
  "split group",
  "scroll area",
  "HTML content",
  "content list",
  "menu bar",
  "menu bar main-menu-bar",
  "toolbar",
  "radio button",
  "close button",
  "minimize button",
  "full screen button",
  "search field",
  "text field",
  "pop up button",
  "toggle button",
  "stepper",
  "combo box",
  "menu item",
  "button",
  "checkbox",
  "heading",
  "image",
  "link",
  "text",
  "grid",
  "list",
  "date time area",
  "row",
  "tab",
  "container",
  "Event",
];

const CLICKABLE_ROLES = new Set([
  "button",
  "radio button",
  "close button",
  "minimize button",
  "full screen button",
  "link",
  "menu item",
  "text field",
  "search field",
  "checkbox",
  "pop up button",
  "toggle button",
  "stepper",
  "combo box",
  "tab",
  "list",            // Calendar 月表示の日付セル（role=list、例："list Saturday, September 19"）
  "date time area",  // Calendar の日付/時刻ピッカー（ID: start-datepicker / start-timepicker など）
]);

/** AX テキストを要素リスト {index, role, label, depth, raw} に解析する。 */
export function parseAX(axText) {
  const out = [];
  for (const line of String(axText ?? "").split("\n")) {
    const m = line.match(/^(\s*)(\d+)\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].replace(/\t/g, "    ").length;
    const rest = m[3].trim();
    const role = ROLES.find((r) => rest === r || rest.startsWith(r + " ")) ?? rest.split(" ")[0];
    // AX メタデータの末尾（"Secondary Actions: Move next, Remove from toolbar" など）を除く。
    // これは要素名ではなく副次操作の一覧であり、残すとラベルを汚染して敏感語ゲートを誤作動させる。
    const label = rest
      .slice(role.length)
      .trim()
      .replace(/,?\s*Secondary Actions:.*$/i, "")
      .trim();
    out.push({ index: Number(m[2]), role, label, depth, raw: line });
  }
  return out;
}

/**
 * 候補の絞り込み：ロールのフィルター + 軽量なスコアリング。
 * 重要な教訓（P0 実測）：位置だけで無条件に切り詰めてはいけない。リスト項目に押し出されて対象が候補から消えるため。
 */
export function selectCandidates(elements, goal = "", { max = 40 } = {}) {
  const tokens = String(goal)
    .toLowerCase()
    .split(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/)
    .filter((t) => t.length >= 2);

  const scored = [];
  for (const el of elements) {
    if (!CLICKABLE_ROLES.has(el.role)) continue;
    let score = 0;
    if (["button", "toggle button", "radio button", "menu item", "pop up button", "combo box"].includes(el.role)) score += 3;
    if (["text field", "search field"].includes(el.role)) score += 2;
    if (el.role === "link") score += 1;
    const label = `${el.label}`.toLowerCase();
    if (label) {
      for (const t of tokens) if (label.includes(t)) score += 4;
    } else {
      score -= 2;
    }
    if (/^javascript:;?$/.test(el.label.trim()) || !el.label.trim()) score -= 2;
    if (/previous month|next month|today|搜索|検索|search/i.test(el.label) && /month|搜索|検索|search/i.test(goal)) score += 6;
    if (el.role === "toggle button" && /toolbar|tool\b|tool\s/i.test(goal)) score += 5;
    scored.push({ ...el, score });
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const clipped = scored.length > max;
  const selected = scored.slice(0, max);
  return Object.assign(selected, { clipped, totalClickable: scored.length });
}

/**
 * Jev に渡す少量のコンテキスト：ウィンドウタイトル + 重要なテキスト行（電卓の表示値など）+ フォーカス行。
 * この「状態フィードバック」が Jev の複数ステップの判断を支え、候補だけで現在値が見えなくなることを防ぐ。
 */
export function buildContext(axText, { maxTextLines = 6 } = {}) {
  const lines = String(axText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines.slice(0, 2);
  const texts = lines.filter((l) => /^\d+\s+text\b/.test(l)).slice(0, maxTextLines);
  const focus = lines.find((l) => /focused UI element/i.test(l));
  return [...head, ...texts, focus].filter(Boolean).join("\n").slice(0, 1_500);
}

/* ------------------------------ cua アダプター ------------------------------ */

export function createCuaDriver(cua) {
  let app = null;
  return {
    async bind(appName) {
      app = await cua.getApp(appName);
      return app;
    },
    async observe({ full = true } = {}) {
      return withRetry(() => app.getAXState({ emit: false, disableDiffing: full }), { attempts: 3, delayMs: 300 });
    },
    async click(index, options) {
      return app.click(index, options);
    },
    async drag(from, to) {
      return app.drag(from, to);
    },
    async setValue(index, value) {
      return app.setValue(index, value);
    },
    async typeText(text) {
      return app.typeText(text);
    },
    async pressKey(key) {
      return app.pressKey(key);
    },
    async scroll(index, direction, pages) {
      return app.scroll(index, direction, pages);
    },
  };
}

/* ------------------------------- メインループ ------------------------------- */

const defaultEmit = (line) =>
  globalThis.nodeRepl?.write ? globalThis.nodeRepl.write(line + "\n") : console.log(line);

export async function runTask({
  driver,
  appName,
  goal,
  dryRun = true,
  maxSteps = 30,
  candidateMax = 40, // 候補の上限：大きなカレンダーツリー（42 日セル + ダイアログ項目）では増やす必要がある
  allowedApps = DEFAULT_ALLOWED_APPS,
  thresholds,
  decide = jevDecide,
  emit = defaultEmit,
  traceDir = path.join(PROJECT_DIR, "runs"),
  traceId,
  resources = {}, // { text, key, direction } は Planner が事前に準備（Jev はテキストを生成しない）
  constraints = "",
  plan = "", // Planner（Codex モデル）が作る手順計画：モデルは「何をするか」、Jev は「どこを操作するか」を決める
  jevOptions = {},
  verify, // 任意：完全な AX → boolean。指定した場合はこれで最終目標を検証する
}) {
  const runId = traceId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${appName.replace(/\W+/g, "")}`;
  fs.mkdirSync(traceDir, { recursive: true });
  const tracePath = path.join(traceDir, `${runId}.jsonl`);
  const record = (entry) => fs.appendFileSync(tracePath, JSON.stringify({ ts: new Date().toISOString(), runId, ...entry }) + "\n");

  emit(`[jev-use] run=${runId} app=${appName} dryRun=${dryRun} goal=${goal}`);
  record({ event: "start", appName, goal, dryRun, maxSteps, plan });

  await driver.bind(appName);
  let observation = await driver.observe({ full: true });
  const recentActions = [];
  const startedAt = Date.now();

  for (let step = 1; step <= maxSteps; step++) {
    // Planner は確定的な手順（キャンバス座標のクリック/ドラッグ/入力）を直接渡せるため、Jev の判断は不要。
    // 「どのツールバー/パネル要素を操作するか」を判断するステップだけを Jev に渡す。
    const planned = typeof resources === "function" ? ((await resources(step, null)) ?? {}) : {};
    if (planned.skipJev) {
      // 旧 Planner 経路には検証可能な目標/リスクがないため、ポリシーを迂回して直接実行しない。
      return finish(dryRun ? "dry_run" : "escalate", {
        steps: step - 1, tracePath, planned,
        message: "Planner の直接操作はプレビューだけ可能です。現在の Computer Use 呼び出しで確認・実行してください。Jev の判断には数えません",
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (verify && await verify(observation)) {
      return finish("done", { steps: step - 1, tracePath, verified: true, elapsedMs: Date.now() - startedAt });
    }
    const stepGoal = planned.jevGoal ?? goal;

    let candidates = selectCandidates(parseAX(observation), stepGoal, { max: candidateMax });
    // 観測が意思決定に足りない場合（前の操作の diff に解析可能な要素がない場合など）は、完全なツリーでもう一度試す。
    if (candidates.length < 2) {
      observation = await driver.observe({ full: true });
      candidates = selectCandidates(parseAX(observation), stepGoal, { max: candidateMax });
      if (candidates.length < 2) {
        record({ event: "no_candidates", step });
        return finish("escalate", {
          steps: step - 1,
          tracePath,
          message: "候補要素が足りず、意思決定できません",
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    if (candidates.clipped) {
      emit(`[step ${step}] 候補を切り詰めました：${candidates.totalClickable} → ${candidateMax}（ロール/関連度順）`);
    }

    let decision;
    try {
      decision = await decide({
        goal: stepGoal,
        app: appName,
        candidates,
        context: buildContext(observation),
        recentActions,
        constraints: [planned.jevPlan ?? "", plan ? `Plan (from planner): ${plan}` : "", constraints].filter(Boolean).join("\n"),
        ...jevOptions,
      });
    } catch (err) {
      record({ event: "decide_error", step, message: err.message });
      return { status: "error", step, message: err.message, tracePath };
    }

    const invalidTarget = decision.targetIndex != null && !candidates.some(c => c.index === decision.targetIndex);
    if (invalidTarget) {
      return finish("escalate", { steps: step - 1, tracePath, message: "対象が現在の候補に含まれていません", elapsedMs: Date.now() - startedAt });
    }
    const gate = evaluatePolicy({ decision, app: appName, allowedApps, step, maxSteps, thresholds, dryRun });
    const target = decision.targetIndex != null ? `i${decision.targetIndex} (${decision.targetLabel ?? "?"})` : "—";
    const line =
      `[step ${step}] Jev ${decision.latencyMs}ms · ${decision.action ?? "?"} ${target} · ` +
      `conf=${fmt(decision.confidence)} risk=${fmt(decision.risk)} done=${fmt(decision.done)} → ${gate.verdict}` +
      (gate.reasons.length ? ` · ${gate.reasons.join("；")}` : "");
    emit(line);
    record({ event: "step", step, candidates: candidates.length, decision: stripRaw(decision), gate });

    if (gate.verdict === "done" && (verify || stepGoal !== goal)) {
      return finish("escalate", { steps: step - 1, tracePath, decision, message: "Jev は完了と判断しましたが、最終目標はまだ検証されていません。現在の段階を確認してください", elapsedMs: Date.now() - startedAt });
    }
    if (gate.verdict === "done") {
      return finish("done", { steps: step - 1, tracePath, decision, gate, elapsedMs: Date.now() - startedAt });
    }
    if (gate.verdict !== "proceed") {
      return finish(gate.verdict, { steps: step - 1, tracePath, decision, gate, elapsedMs: Date.now() - startedAt });
    }
    if (dryRun) {
      return finish("dry_run", {
        steps: 0,
        tracePath,
        planned: { action: decision.action, targetIndex: decision.targetIndex, targetLabel: decision.targetLabel },
        gate,
        elapsedMs: Date.now() - startedAt,
      });
    }

    const tAct = Date.now();
    // パラメーターは静的設定でも、ステップごとに生成するコールバックでもよい（Planner は「何をするか」、Jev は「どこを操作するか」を決める）。
    const stepResources = typeof resources === "function" ? ((await resources(step, decision)) ?? {}) : resources;
    try {
      await executeAction(driver, decision, stepResources);
    } catch (err) {
      record({ event: "action_error", step, message: err.message });
      return finish("error", { steps: step, tracePath, message: `操作の実行に失敗しました：${err.message}`, elapsedMs: Date.now() - startedAt });
    }
    const actMs = Date.now() - tAct;

    const previousObservation = observation;
    observation = await driver.observe({ full: true });
    const noChange = observation === previousObservation;
    recentActions.push(`${decision.action} i${decision.targetIndex} → ${noChange ? "no change" : "changed"}`);
    emit(`         └ 操作 ${actMs}ms · ${noChange ? "画面に変化なし" : "画面が変化"}`);
    record({ event: "action", step, actMs, noChange, action: decision.action, targetIndex: decision.targetIndex });
  }

  if (verify && await verify(observation)) {
    return finish("done", { steps: maxSteps, tracePath, verified: true, elapsedMs: Date.now() - startedAt });
  }
  return finish("max_steps", { steps: maxSteps, tracePath, elapsedMs: Date.now() - startedAt });

  function finish(status, extra) {
    record({ event: "finish", status, ...extra });
    emit(`[jev-use] 終了：${status} · 所要時間 ${(extra.elapsedMs / 1000).toFixed(1)}s · trace=${tracePath}`);
    return { status, ...extra };
  }
}

async function executeAction(driver, decision, resources) {
  switch (decision.action) {
    case "click_element":
      if (Array.isArray(resources.at)) return driver.click(resources.at);
      return driver.click(decision.targetIndex, resources.mouseButton ? { mouseButton: resources.mouseButton } : undefined);
    case "click_at":
      return driver.click(resources.at);
    case "drag":
      return driver.drag(resources.from, resources.to);
    case "set_value":
      return driver.setValue(decision.targetIndex, String(resources.text ?? ""));
    case "type_text":
      return driver.typeText(String(resources.text ?? ""));
    case "press_key":
      return driver.pressKey(String(resources.key ?? "Return"));
    case "scroll":
      return driver.scroll(decision.targetIndex, String(resources.direction ?? "down"), 1);
    case "wait":
      return sleep(500);
    default:
      throw new Error(`未対応の操作種別：${decision.action}`);
  }
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "n/a");
const stripRaw = ({ raw, ...rest }) => rest;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一時的なインフラエラー（ScreenCaptureKit/無効なパラメーター）を自動リトライする。 */
export async function withRetry(fn, { attempts = 3, delayMs = 350 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = /ScreenCaptureKit|invalid parameter|-10005|timeout/i.test(String(err));
      if (!transient || i === attempts - 1) throw err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
