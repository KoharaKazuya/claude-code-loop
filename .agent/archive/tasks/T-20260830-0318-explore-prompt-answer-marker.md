---
title: "探索セッション向け指示文の回答判定表記をチェックボックス方式へ合わせる"
status: completed
priority: 2
dependencies: []
retries: 0
note: "注入文をチェックボックス方式へ書き換え、回帰テスト 2 件を追加。typecheck / lint / test すべて成功"
createdAt: 2026-08-30T03:18:17.730Z
---

所属フェーズ: 現在フェーズ内の表記不一致の解消。利用者から見た挙動は変わらないため人間の確認は不要
(`.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` の「確認を取らない」側)。

## 目的

`lib/supervisor.ts` の `buildExplorePrompt` が探索セッションへ注入する手順 1 の文言が、
チェックボックス方式の回答フォーマット導入以前の表記のまま残っている。現行仕様に合わせる。

## 現状(確認済みの事実)

- `lib/supervisor.ts:2521` 付近の注入文は「`対応:` が「不要」ならそのまま closed にする。
  それ以外は回答内容に沿って新タスクとして登録し、」となっている。
- 一方 `lib/prompt/PROMPT.md` の Human Review テンプレートと `lib/triage.ts` の
  `isNoActionAnswer` / `readAnswerCheckboxes` は、`## 回答` 節のチェックボックス
  (`- [ ] 対応不要(このままクローズしてよい)` / `- [ ] 回答を下に書いた`)で回答を判定する。
  `対応:` というマーカーは現行のテンプレートにもパーサにも存在しない。
- `lib/triage.ts` の Stage 2 は close / task / escalate の 3 択だが、注入文の分岐は
  「対応不要 → closed」「それ以外 → 新規タスク登録」の 2 択しかなく、
  「回答は書かれているが新規タスクは不要(既に別タスクで対応済み・感想のみ等)」の受け皿がない。

## 完了条件

- 注入文がチェックボックス方式の判定を指すよう書き換わっている。
  最低限、「対応不要にだけチェック」「回答が書かれている」の 2 系統を区別でき、
  後者について「新規タスク化が不要なら closed にしてよい」ことが読み取れること。
- Stage 1/2 の判定(`lib/triage.ts`)と矛盾しない表現になっていること。
- `buildExplorePrompt` の出力に対する回帰テストを `lib/supervisor.test.ts` に追加し、
  現行テンプレートに存在しない `対応:` マーカーが注入文へ再び混入しないことを検知できるようにする。
- `npm run typecheck` / `npm run lint` / `npm test` が通ること。

## 注意

`lib/prompt/PROMPT.md` 側は既にチェックボックス方式で正しい。直すのは `lib/supervisor.ts` の
注入文である。実装本体(`lib/triage.ts`)の判定ロジックは変更しないこと。
