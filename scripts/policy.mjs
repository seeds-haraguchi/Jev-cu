/**
 * Policy Gate —— Computer Use の確認ポリシーをコードのゲートとして実装する。
 * 純粋関数で副作用がなく、cua ランタイムなしで単体テストできる。
 */

export const DEFAULT_ALLOWED_APPS = [
  "Calendar",
  "Calculator",
  "TextEdit",
  "NetEaseMusic",
  "Figma",
  "Google Chrome",
  "Codex In-app Browser",
];

/** 対象要素の文言がこれらのパターンに一致したら、必ず確認のため停止する。 */
export const SENSITIVE_LABEL_PATTERNS = [
  { id: "delete", re: /删除|移除|清空|削除|除去|消去|クリア|delete|remove/i },
  { id: "send", re: /发送|提交|发布|回复|送信|提出|公開|投稿|返信|send|submit|post|reply/i },
  { id: "payment", re: /支付|付款|购买|下单|充值|订阅|开通|支払い|決済|購入|注文|チャージ|購読|契約|pay|purchase|buy|subscribe|checkout/i },
  { id: "auth", re: /授权|权限|登录|密码|验证码|認証|権限|ログイン|パスワード|確認コード|authorize|permission|sign in|login|password|captcha/i },
  { id: "share", re: /上传|分享|导出|アップロード|共有|エクスポート|書き出し|upload|share|export/i },
  { id: "install", re: /安装|インストール|導入|install/i },
  { id: "settings", re: /系统设置|偏好设置|安全设置|システム設定|環境設定|セキュリティ設定|system settings|security settings/i },
];

export const DEFAULT_THRESHOLDS = {
  doneProbability: 0.9, // 完了確率がこの値以上 → 終了
  riskConfirm: 0.2, // リスク確率がこの値以上 → 確認のため停止
  minConfidence: 0.5, // 対象信頼度がこの値未満 → エスカレーション（リトライ/画面確認/質問）
  lowRiskMinConfidence: 0.4, // 副作用のない App（電卓/カレンダー/テキスト編集）は 0.4 まで緩和
  stopConfidence: 0.3, // 対象信頼度がこの値未満 → 直ちに停止
};

/** 副作用がなく、いつでもやり直せる App。信頼度のしきい値を緩和できる（安全性は risk と敏感語で確認）。 */
export const LOW_RISK_APPS = ["Calculator", "Calendar", "TextEdit", "Figma"];

export function matchSensitive(label = "") {
  const text = String(label);
  return SENSITIVE_LABEL_PATTERNS.find((p) => p.re.test(text)) ?? null;
}

/**
 * @param {object} input
 * @param {object} input.decision  normalizeDecision の出力
 * @param {string} input.app
 * @param {string[]} [input.allowedApps]
 * @param {number} [input.step]
 * @param {number} [input.maxSteps]
 * @param {object} [input.thresholds]
 * @param {boolean} [input.dryRun]
 * @returns {{verdict:"proceed"|"done"|"confirm"|"escalate"|"stop", kind?:string, reasons:string[]}}
 */
export function evaluatePolicy({
  decision,
  app,
  allowedApps = DEFAULT_ALLOWED_APPS,
  step = 1,
  maxSteps = 30,
  thresholds = DEFAULT_THRESHOLDS,
  dryRun = false,
}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "n/a");

  if (step > maxSteps) {
    return { verdict: "stop", kind: "budget", reasons: [`step ${step} が上限 ${maxSteps} を超えています`] };
  }
  if (typeof decision?.done === "number" && decision.done >= t.doneProbability) {
    return { verdict: "done", reasons: [`完了確率 ${fmt(decision.done)}`] };
  }

  const reasons = [];
  if (!allowedApps.includes(app)) reasons.push(`App「${app}」は許可リストにありません`);
  const sensitive = matchSensitive(decision?.targetLabel);
  if (sensitive) reasons.push(`対象が「${sensitive.id}」種別の敏感な操作の可能性があります：${decision.targetLabel}`);
  if (typeof decision?.risk === "number" && decision.risk >= t.riskConfirm) {
    reasons.push(`Jev のリスク判定 ${fmt(decision.risk)} ≥ ${t.riskConfirm}`);
  }
  if (decision?.action === "ask_user") reasons.push("Jev はユーザーの介入が必要と判断しました");
  if (reasons.length) return { verdict: "confirm", kind: "sensitive", reasons, dryRun };

  if (![decision?.confidence, decision?.risk, decision?.done].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
    return { verdict: "escalate", kind: "invalid_decision", reasons: ["意思決定の確率がないか、0～1 の範囲外です"] };
  }
  if (typeof decision?.confidence === "number" && decision.confidence < t.stopConfidence) {
    return { verdict: "stop", kind: "low_confidence", reasons: [`対象信頼度 ${fmt(decision.confidence)} < ${t.stopConfidence}`] };
  }
  const minConfidence = LOW_RISK_APPS.includes(app) ? t.lowRiskMinConfidence : t.minConfidence;
  if (typeof decision?.confidence === "number" && decision.confidence < minConfidence) {
    return {
      verdict: "escalate",
      kind: "low_confidence",
      reasons: [`対象信頼度 ${fmt(decision.confidence)} < ${minConfidence}`],
      minConfidence,
    };
  }
  if (decision?.targetIndex == null && decision?.action !== "wait") {
    return { verdict: "escalate", kind: "no_target", reasons: ["対象要素が選択されていません"] };
  }

  return { verdict: "proceed", reasons: [] };
}
