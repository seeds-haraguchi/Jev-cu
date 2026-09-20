# 実行例

以下のコードは `cua_repl` でのみ使用します。最初の呼び出しでは `await cua.getApp("Calendar")` だけを実行して、返されたツールドキュメントを読みます。インポートとループは後続の呼び出しに置きます。現在のインターフェースと driver が一致しない場合は停止して適合させ、API を推測しません。

```js
var jevUrl = await import("node:url");
var repoDir = "{{REPO_DIR}}"; // スキルのインストール時にこのリポジトリのパスへ自動置換
var jevLoop = await import(jevUrl.pathToFileURL(
  repoDir + "/scripts/loop.mjs"
).href);

// 現在の AX から実際のロール、ラベル、ID、選択状態を確認する。
// この判定は week-button / Value: 1 が観測された Calendar 画面に適用する。
var weekSelected = ax => ax.split("\n").some(line =>
  /radio button/.test(line) && /ID: week-button\b/.test(line) && /Value: 1\b/.test(line)
);
var jevResult = await jevLoop.runTask({
  driver: jevLoop.createCuaDriver(cua),
  appName: "Calendar",
  goal: "Switch Calendar to Week view.",
  dryRun: true,
  maxSteps: 2,
  verify: weekSelected,
});
nodeRepl.write(jevResult);
```

プレビューを通過し、操作が許可された後にだけ `dryRun: false` に変更します。最初から週表示なら検証を直接完了できるため、デモのために再度クリックしてはいけません。

- `verify(ax)`：読み取り専用の最終目標判定。各ステップの前と最後のステップの後に確認します。ボタンの存在だけでなく、選択状態や結果の値を照合します。
- `resources: { text, key, direction }`：Codex が提供する操作パラメーター。動的な値が必要なら副作用のないコールバックを使えます。各ステップで 2 回呼ばれることがあります（意思決定前の引数は `null`、意思決定後は decision）。
- 複数段階の長いタスクを異なる `jevGoal` の混在で組み立てません。各段階を個別に呼び出して検証してから次へ進みます。
- 候補の上限はデフォルトで 40。増やす前に、ロールのフィルターやラベルに問題がないか確認します。
- `cua_repl` のデフォルトタイムアウトは 30 秒です。API と観測の時間を含む長さを指定します。デモは 1 段階あたり 2～3 ステップ以内とし、ツールのタイムアウトは 60 秒にできます。外側のタイムアウト後はまず状態と軌跡を確認し、操作が行われなかったと仮定しません。
- `plan` はヒントであり、永続的な実行進捗ではありません。静的な操作計画や `skipJev` を Jev の意思決定性能の証拠にしてはいけません。

現在のポリシーには、App ごとのしきい値緩和とキーワード誤判の限界があります。許可リストや低リスク分類を、その App のすべての書き込み操作への許可と解釈してはいけません。複雑な入力、座標ドラッグ、ブラウザチャネルは別途検証が必要です。
