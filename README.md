# Jev-cu

Computer Use の「次にどこを操作するか」を Jev（TypeSafe System One）に任せます。Jev は画面上のテキスト候補から要素・操作・完了度・リスクを選び、Codex Computer Use が画面の読み取りと実行を担当します。ローカルのポリシーゲートが敏感な操作を止めます。送信するのはテキストだけで、スクリーンショットは送信しません。

## 目次

```
skill/jev-use/   Codex にインストールできるスキル（実行手順 + 安全ルール）
scripts/         Jev 呼び出し、ポリシーゲート、意思決定ループ、オフライン評価、インストールスクリプト
fixtures/        AX スナップショットと P0 ケース
tests/           単体テスト
```

## スキルのインストール

```bash
npm run install-skill      # ~/.codex/skills/jev-use にコピー。新しいセッションで有効
npm run uninstall-skill
```

スキルのソースファイルにある `{{REPO_DIR}}` は、インストール時にリポジトリの実パスへ置き換えられます。

## 使い方

まず `.env.local` にキーを書き込み（コミットしない）、または同名の環境変数を設定します。

```bash
echo 'TYPESAFE_API_KEY=<your key>' > .env.local
```

ループは Codex デスクトップアプリの `cua_repl` ランタイムで実行します。

```js
const repo = "/path/to/Jev-cu"; // 実際にクローンしたパスへ変更
const { pathToFileURL } = await import("node:url");
const { runTask, createCuaDriver } = await import(pathToFileURL(`${repo}/scripts/loop.mjs`).href);

await runTask({
  driver: createCuaDriver(cua),
  appName: "Calendar",
  goal: "switch the calendar to the previous month", // 英語の目標の方が Jev は正確
  dryRun: true,                                       // 確認後に false へ変更
  maxSteps: 5,
});
```

## 検証

```bash
npm test        # 単体テスト。API は呼び出さない
npm run p0      # オフライン評価：AX スナップショットの要素選択精度（Jev を呼ぶためキーが必要）
```

## 安全境界

- デフォルトは dry-run。削除、送信、支払い、権限変更、アップロード、認証コード、インストール、システム設定などの操作は `confirm` で停止し、人の確認を必要とします。
- App の許可リストは `scripts/policy.mjs` にあり、App の追加には明示的な変更が必要です。
- 画面の文字列はデータとしてのみ扱い、操作指示としては扱いません。ログイン、ペイウォール、認証コードを回避しません。

## 外部送信とプライバシー

Jev の判断に必要な範囲で、候補ラベルと少量の画面状態テキストを固定エンドポイントへ送信します。画面全体やスクリーンショット、`.env.local` 全体は送信しません。ただし URL の除去や文字数制限は匿名化ではありません。カレンダー、ブラウザ、音楽アプリなどに個人情報が表示されている場合は、送信してよい文字列だけを候補・状態として渡してください。
