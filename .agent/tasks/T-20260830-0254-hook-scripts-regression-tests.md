---
title: "テストの無い hook スクリプトに回帰検知テストを足す"
status: completed
priority: 3
dependencies: [T-20260830-0254-test-env-isolation-session-vars]
retries: 0
note: "3 hook のテストを追加。worktree-create の重複テストは hooks 側へ集約。settings.template.json の PreToolUse/matcher 結び付きも構造検証に変更"
createdAt: 2026-08-30T02:54:00.229Z
---

所属フェーズ: 現在フェーズ内の検証強化。機能追加ではない。

## 目的

`lib/hooks/` 配下のうち、次の 3 つには単体テストが存在しない。どれも壊れても他のテストでは
検知できず、壊れたときの症状が「静かに無効化される」タイプなので、回帰検知テストを足す。

### `lib/hooks/deny-ask-user.ts`

自律実行中の `AskUserQuestion` を deny し、絶対ルール 1(人間への回答待ちで停止しない)を
実際に担保している唯一の実装。ロジックに分岐は無いが、Claude Code の PreToolUse hook が
期待する JSON の形(`hookSpecificOutput.hookEventName` / `permissionDecision` のキー名・値)が
ずれると無音で効かなくなる。そのときの症状は「無人運用中のセッションが人間の回答を待って
止まる」という、まさに防ごうとしている事態そのものである。

### `lib/hooks/worktree-create.ts`

path traversal 対策の入力検証(`/^[A-Za-z0-9._-]+$/` と `/^\.+$/` の組み合わせ)を含む。
下請けの `lib/worktree.ts` は `worktree.test.ts` で厚くテスト済みなので、対象は hook 自身の
グルーと入力検証部分に限る。

### `lib/hooks/stdin.ts`

hook の stdin から JSON を読む共通処理で、上記 2 つと `lib/hooks/stop-check.ts` の
すべてが依存する土台。空入力・パース不能を握りつぶして `{}` を返す設計のため、壊れると
hook 側では「入力が空だった」と区別がつかず、無音で誤動作する。上記 2 ファイルのテストを
書く前提としても押さえておきたい。

## 完了条件

- 上記 3 ファイルに対応するテストを追加する。既存の hook テスト
  (`lib/hooks/stop-check.test.ts` など)の書き方に揃える。
- 検証対象は「出力 JSON の形とキーの値」「不正な入力を弾くこと」「対象外の入力に対して
  何もしないこと」を最低限含める。カバレッジ稼ぎの薄いテストは書かない。
- 子プロセスの env を組み立てる場合は、依存タスク
  `T-20260830-0254-test-env-isolation-session-vars` で用意された方式に従う
  (親セッションの `CLAUDE_AGENT_*` を継承しない)。
- `npm run typecheck` / `npm run lint` / `npm run test` が通る。

## 補足(未検証事項)

「本番の `ccloop run` 上で `deny-ask-user.ts` が PreToolUse hook として実際に発火しているか」は
単体テストの範囲外であり、今回の調査では未確認である。このタスクで担保できるのは
スクリプト単体の入出力契約までである点に留意すること。実機での発火確認が必要と判断した場合は、
このタスクに含めず別タスクとして登録する。

### 対応結果(このタスク内で処理した範囲)

`lib/settings.test.ts` の既存検証は `JSON.stringify(hooks)` にスクリプトパスが含まれることしか
見ておらず、エントリが別の hook イベント配下へ移っても matcher が変わっても通ってしまう状態だった。
そのため「`hooks.PreToolUse` に `matcher: "AskUserQuestion"` のエントリがあり、その配下の command が
`deny-ask-user.ts` を指す」ことを構造として検証するテストを追加した。

これにより静的に検証できる範囲(スクリプトの入出力契約 + テンプレートへの登録の結び付き)は
埋まったと判断し、実機での発火確認タスクは登録していない。残る未検証部分は
「Claude Code が settings.json の記述どおりに hook を発火させること」であり、これは
ccloop 側では検証しようがない外部依存である。
