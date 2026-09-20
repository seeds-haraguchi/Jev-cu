#!/usr/bin/env node
/**
 * Jev の意思決定ラッパー（TypeSafe API へ直接接続）。
 *
 * - キーの読み取り：環境変数 TYPESAFE_API_KEY またはプロジェクトルートの .env.local
 * - ask()   ：systemone リクエストを 1 回送信（複数の質問を並行可能）
 * - decide()：Computer Use ループ用の標準 4 問（target/action/done/risk）
 *
 * CLI（デバッグ用）：
 *   node scripts/jev-decide.mjs payload.json
 *   cat payload.json | node scripts/jev-decide.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
/** 公式価格：入力は $42/Btok = $0.042/Mtok、出力は無料。 */
export const PRICE_PER_INPUT_TOKEN_USD = 0.042 / 1e6;

export function loadApiKey({
  envVar = "TYPESAFE_API_KEY",
  envFile = path.join(PROJECT_DIR, ".env.local"),
} = {}) {
  const env = globalThis.process?.env ?? {};
  if (env[envVar]) return String(env[envVar]).trim();
  try {
    const text = fs.readFileSync(envFile, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === envVar) return m[2].replace(/^['"]|['"]$/g, "").trim();
    }
  } catch {
    /* ファイルがない場合は共通のエラー処理へ進む。 */
  }
  throw new Error(`${envVar} が見つかりません。環境変数を設定するか、${envFile} に書き込んでください`);
}

export function estimateCostUsd(usage = {}) {
  const tokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  return tokens * PRICE_PER_INPUT_TOKEN_USD;
}

function toNumber(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 候補の説明を整形する：URL などのノイズを除去し、トークン量を制限する（単体テスト用に export）。 */
export function sanitizeLabel(text, max = 120) {
  return String(text ?? "")
    .replace(/\b(?:https?|orpheus|file|javascript|data):\S*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** ループ用の標準 4 問を構築する（単体テスト用に export）。 */
export function buildQuestions(goal, candidates = []) {
  const criteria = {};
  for (const c of candidates) criteria[`i${c.index}`] = sanitizeLabel(`${c.role}: ${c.label}`);

  return {
    criteria,
    questions: {
      target: {
        type: "choice",
        instructions: `Which single element should be acted on next to accomplish the goal? Goal: ${goal}`,
        criteria,
      },
      action: {
        type: "choice",
        instructions: "What is the next action type?",
        criteria: {
          click_element: "Click the chosen element",
          click_at: "Click a canvas position (coordinates come from the planner)",
          drag: "Drag on the canvas (coordinates come from the planner)",
          set_value: "Replace the value of a text input",
          type_text: "Type the provided text",
          press_key: "Press a keyboard key",
          scroll: "Scroll the current view",
          wait: "Wait for the UI to update",
          ask_user: "Stop and ask the user",
        },
      },
      done: {
        type: "noul",
        instructions: "Is the goal already visibly achieved in the current UI state?",
      },
      risk: {
        type: "noul",
        instructions:
          "Does the next action require explicit user confirmation (delete data, send/submit, pay/subscribe, change permissions, upload/share, solve CAPTCHA, install software, change system settings, enter credentials)?",
        criteria: {
          true: "delete / send / pay / permission / upload / captcha / install / system settings / credentials",
          false: "safe reversible navigation such as opening, searching, scrolling, selecting, reading",
        },
      },
    },
  };
}

/** API の answers をループで使える形に正規化する（単体テスト用に export）。 */
export function normalizeDecision(answers = {}, criteria = {}) {
  const targetKey = answers.target?.choice ?? null;
  const valid = typeof targetKey === "string" && /^i\d+$/.test(targetKey) && Object.hasOwn(criteria, targetKey);
  return {
    action: answers.action?.choice ?? null,
    targetKey: valid ? targetKey : null,
    targetIndex: valid ? Number(targetKey.slice(1)) : null,
    targetLabel: valid ? (criteria[targetKey] ?? null) : null,
    done: toNumber(answers.done?.noul ?? answers.done?.probability),
    risk: toNumber(answers.risk?.noul ?? answers.risk?.probability),
    confidence: toNumber(answers.target?.confidence),
    probabilities: answers.target?.probabilities ?? {},
  };
}

export async function ask({
  state,
  questions,
  model = DEFAULT_MODEL,
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  maxRetries = 2,
  timeoutMs = 60_000,
  fetchImpl = fetch,
}) {
  const key = apiKey ?? loadApiKey();
  const backoff = [1_000, 3_000, 8_000];

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model, questions }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - startedAt;
    const body = await res.json().catch(() => null);

    if (res.ok && body?.answers) {
      return {
        answers: body.answers,
        usage: body.usage ?? {},
        model: body.model ?? model,
        latencyMs,
        costUsd: estimateCostUsd(body.usage),
        raw: body,
      };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const message = body?.detail?.message ?? body?.error?.message ?? JSON.stringify(body)?.slice(0, 200) ?? res.statusText;
      const err = new Error(`Jev の呼び出しに失敗しました HTTP ${res.status}（${latencyMs}ms）：${message}`);
      err.status = res.status;
      throw err;
    }
    await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
  }
}

/**
 * Computer Use ループの標準意思決定エントリーポイント。
 * @param {object} input
 * @param {string} input.goal 英語の目標（Jev は英語の方が正確）
 * @param {string} input.app
 * @param {Array<{index:number, role:string, label:string}>} input.candidates
 * @param {string} [input.context] 少量の画面コンテキスト（ウィンドウタイトル/フォーカス行）
 * @param {string[]} [input.recentActions]
 * @param {string} [input.constraints]
 */
export async function decide({
  goal,
  app,
  candidates = [],
  context = "",
  recentActions = [],
  constraints = "",
  ...askOptions
}) {
  const { criteria, questions } = buildQuestions(goal, candidates);
  const state = {
    goal,
    app,
    context: String(context).slice(0, 1_500),
    candidates: Object.entries(criteria).map(([id, desc]) => ({ id, desc })),
    recent_actions: recentActions.slice(-6),
    constraints,
  };
  const r = await ask({ state, questions, ...askOptions });
  return {
    ...normalizeDecision(r.answers, criteria),
    usage: r.usage,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    model: r.model,
    raw: r.raw,
  };
}

/* ------------------------------- CLI ------------------------------- */

async function main() {
  const file = process.argv[2];
  const raw = file
    ? await fs.promises.readFile(file, "utf8")
    : await new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      });
  const payload = JSON.parse(raw);
  const result = await ask({
    state: payload.state,
    questions: payload.questions,
    model: payload.model ?? DEFAULT_MODEL,
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[jev-decide] ${err.message}`);
    process.exit(1);
  });
}
