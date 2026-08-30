---
title: "セッション終了処理の配線に結合テストを足す"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T03:18:17.730Z
---

所属フェーズ: 現在フェーズ内の検証強化。機能追加ではないため人間の確認は不要
(`.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` の「確認を取らない」側)。

## 目的

タスクセッション終了時の後始末(`finishTaskSession`)は、マージ結果 × セッション実行結果 ×
マージ中断の有無で十数通りに分岐し、worktree の片付け・パッチ退避・タスクファイル更新・
state 更新という「壊れると main やコミット済みの成果を失いうる」副作用を順序依存で実行する。
ここに直接のテストが無い。壊れたことを検知できる最小限の結合テストを足す。

## 現状(確認済みの事実)

- `lib/supervisor.test.ts` には `finishTaskSession` / `recoverOrphanBranch` /
  `abortInterruptedAutoMerge` を呼ぶテストが 1 件も存在しない(grep で出現数 0)。
- 個々の純粋関数(`mainChangedByTaskOutcome`、`nextFastCrashStreak` 等)は切り出されテスト済みで、
  それらを組み合わせる配線だけが未検証。
- 起動時復旧は `recoverStartupIn` 経由で間接的にカバーされているが、`recoverOrphanBranch` の
  `wedged` 分岐・worktree なしでの衝突退避分岐が個別に検証されているかは未確認。

## 完了条件

- `finishTaskSession` に対する結合テストを追加し、少なくとも次の組み合わせを検証する。
  - マージ成功 × セッション成功: worktree とブランチが片付き、タスクが completed 相当で残る
  - マージ衝突: worktree とブランチが残り、次回が衝突解消セッションとして起動できる状態になる
  - セッションのタイムアウト/クラッシュ × 未コミット差分あり: パッチが退避され、
    退避先のパスがタスク本文の `## 試行履歴` に追記される
  - リトライ上限到達: タスクが failed になり、worktree が片付く
- `recoverOrphanBranch` の `wedged` 分岐と、worktree が存在しない状態での衝突退避分岐に
  テストを足す(既存の `recoverStartupIn` テストで既にカバー済みなら、その旨をタスクの
  `note` に書いて追加は省いてよい)。
- 既存テストのヘルパ(一時 git リポジトリを作る仕組み)がある場合はそれに合わせる。
  無ければ `lib/merge.test.ts` の作り方を参考にする。
- `npm run typecheck` / `npm run lint` / `npm test` が通ること。

## 注意

- テストを通すために実装側の検証を弱めないこと。実装の不具合を見つけた場合は、
  その場で直さず新しいタスクとして `.agent/tasks/` に登録する(ただし修正が数行で済み、
  仕様上明らかな誤りなら直してよい。その場合は理由を `.agent/decisions/` に残す)。
- 分量が多い。1 セッションで全部終わらない場合は、終わった分をコミットしたうえで
  status を `ready` に戻し、残りを `## 試行履歴` に書いて引き継ぐこと。
