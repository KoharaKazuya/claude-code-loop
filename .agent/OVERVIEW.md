---
updatedAt: 2026-08-30T02:54:00.229Z
completed: 4
total: 7
---

# OVERVIEW(GOAL に対する現在地)

GOAL に記載された「現在の目標」のうち、1 つ目(decisions アーカイブの人間承認化、
`ccloop status` への未承認決定の表示)は完了済み。該当タスクは archive にあり、
`.agent/decisions/index.md` によるチェックボックス承認と、ローテーション時の 3-way マージによる
衝突解消まで実装・テスト済みである。

2 つ目の「人間の確認・介入の導線を磨く」は継続中。`ccloop status` の表示項目
(未回答 Human Review・チェック忘れ検知・failed/blocked・衝突 worktree・未承認決定・
権限拒否サマリ・実行中/次のタスク・コスト)と、Human Review 取り込み(Stage 1/2/3)・
decisions 承認の実装は、`lib/prompt/PROMPT.md` の仕様と突き合わせた限り食い違いがない。
機能面の欠落は大きくなく、残っているのは **導線が実際には届いていない/検証が信用できない**
という 2 種類の綻びである。

## 綻び 1: インストール済み ccloop とリポジトリの乖離

このリポジトリは公開版 ccloop feature を DevContainer に入れて自己ホストしているため、
`ccloop` の実体はインストール先(`/usr/local/share/ccloop/lib/`)であり、リポジトリの `lib/` を
直しても再インストールするまで人間の手元の挙動は変わらない。現に、未承認の決定が 8 件ある
状態でも `ccloop status` の要対応欄にそれが出ない(表示機能はマージ済みだが、インストール済みの
コピーがその実装を含まないため)。既存の陳腐化警告は `ccloop run` 起動時点との比較のみで、
この乖離を検出しない。対応タスクは実行中。

## 綻び 2: 自己ホスト環境で機械的検証が赤くなる

同じ自己ホスト構造の副作用として、セッション内で `npm test` を実行すると親セッションの
`CLAUDE_AGENT_SESSION_KIND` などが子プロセスへ漏れ、`lib/hooks/stop-check.test.ts` の 3 件が
そこでだけ失敗する。実装は正しく、テストの環境分離が不十分なだけである。全セッションが
着手前に見る検証が常時赤いままだと、本物の退行が「いつもの失敗」に埋もれる。

## 次にやること

- `T-20260830-0254-test-env-isolation-session-vars`(priority 1) — 綻び 2 の修理。
  全セッションの検証の信頼性に関わるため最優先。
- `T-20260830-0236-status-installed-source-drift`(priority 2、実行中) — 綻び 1 の修理。
- `T-20260830-0254-hook-scripts-regression-tests`(priority 3) — `deny-ask-user` /
  `worktree-create` の回帰検知テスト。前者は絶対ルール 1 を担保する唯一の実装だが未検証。

## フェーズ

- 現在フェーズ: **4(思いつく改善すべて)** と見なしている。フェーズ 1〜3 は公開版のリリースと
  自己ホスト運用によって既に越えている(判断の根拠は
  `.agent/decisions/D-20260830-0236-phase-assessment-and-single-gate.md`)。
- ゲートの回答状況: フェーズ 1〜3 の遡及確認とフェーズ 4 の運用可否を 1 通に集約した
  `HR-20260830-0236-phase-gate-applicability`(BLOCK)が **未回答**。
- 回答があるまで、フェーズ 4 の個別トピック確認 HR は作らず、現在フェーズ内の修理・検証にあたる
  作業のみタスク化する。今回登録した 2 件はいずれもこの範囲内(既存機能の不具合修理と、
  既存の安全策への回帰検知テスト)。
