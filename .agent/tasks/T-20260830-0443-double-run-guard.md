---
title: "同じリポジトリでループを二重起動したときに状態が壊れるのを防ぐ"
status: completed
priority: 2
dependencies: [T-20260830-0424-liveness-unreadable-record]
retries: 0
note: "mainLoop 先頭に二重起動ガードを追加。--force で強制起動可"
createdAt: 2026-08-30T04:43:06.417Z
updatedAt: 2026-08-30T04:54:35.542Z
---

所属フェーズ: 4(思いつく改善すべて)。不具合の修理のため個別確認は取っていない。

## 目的

同一リポジトリに対して `ccloop run` を 2 つ起動すると、後から起動したほうが**先に動いている
ほうの実行状態を壊す**。これを防ぐ。

## 現状(調査済みの事実)

- `mainLoop`(`lib/supervisor.ts:3239` 付近)は起動時に生存記録(`runner.json`)を一切確認せず、
  無条件で `touchRunnerRecord` → `recoverStartup` を呼ぶ。
- `recoverStartupIn`(`lib/supervisor.ts:1399` 付近)は「起動直後に走っているセッションは無い」
  という前提で `state.runningSessions` を無条件に空へ書き戻す。
- メインループは毎周回 `loadState()` を読み直し、`runningSessions` を同時実行数の判断に使う
  (`lib/supervisor.ts:3321` 付近)。
- worktree のパスはタスク ID だけで決まる(`lib/worktree.ts:21` 付近)ため、2 プロセスが同じ
  タスクを選ぶと同じディレクトリを取り合う。マージ(`lib/merge.ts:385` 付近)はリポジトリ本体の
  作業ツリーに対して `git merge` するため、同時実行で git 操作が競合しうる。
- README / docs / `lib/prompt/PROMPT.md` のいずれにも「同一リポジトリで同時に 1 つだけ」という
  記載は無い(grep で確認済み)。

結果として、先行プロセスが管理していたセッションの追跡情報が消え、同時実行数の上限を超えた
過剰起動・同じ worktree への二重作成・本体リポジトリ上でのマージ競合が起こりうる。

## 完了条件

- 起動時に生存記録を確認し、**同じリポジトリでループが生きていると判定できる場合は起動を拒否する**
  (`recoverStartup` へ進む前に止めること。状態を書き換えてからでは手遅れになる)。
- 拒否時のメッセージは、原因(既に動いている)と対処(先に止める / `ccloop status` で確認する)が
  分かる文言にする。
- 生死の判定は `lib/liveness.ts` の既存の評価を使う。「動いていない」と判定できる場合と、
  生存記録が壊れている・読めない場合の扱いを分けること(後者で起動を拒否すると、記録が壊れただけで
  ループを二度と起動できなくなる)。PID 使い回しの扱いは
  `.agent/decisions/D-20260830-0424-liveness-pid-reuse-token.md` に従う。
- 強制的に起動する逃げ道を設けるかどうかは実装者が判断してよい(設けるなら README にも書く)。
- 「同一リポジトリでは同時に 1 つだけ」という前提を README(または `docs/architecture.md` の
  適切な箇所)に一行足す。
- 回帰テストを追加する: 生存記録が「生きている」状態のときに起動が拒否され、かつ
  `state.runningSessions` が書き換えられないこと。
- 利用者から見た挙動が変わるため `CHANGELOG.md` の「## 未リリース」に 1 行足す。

## 補足

`T-20260830-0424-liveness-unreadable-record`(生存記録が読めないときの表示)と
`lib/liveness.ts` で衝突しうるため依存に入れている。先にそちらを取り込むこと。

## 試行履歴

### 試行 1(2026-08-30T04:54:35.542Z, セッション記録)
- 確認済みの事実: コミット c6dcc4c で完了条件をすべて実装した。`lib/liveness.ts` に純粋関数
  `evaluateStartupGuard` を追加し、`mainLoop` の先頭(`generateSettings` より前)で評価して
  拒否時は `process.exitCode = 1` で即 return する。`ccloop run --force` を逃げ道として追加し、
  README・`lib/help.ts`・CHANGELOG「## 未リリース」に反映した。テストは `evaluateStartupGuard` の
  6 variant 全網羅と、`mainLoop` が拒否時に `state.runningSessions` を書き換えない回帰テスト。
  検証は `npm run typecheck` / `npm run lint` / `npm test`(31 files 949 tests)すべて成功。
  判定方針は `.agent/decisions/D-20260830-0453-startup-guard-refusal-policy.md` に記録した。
- 未検証の推測: 実プロセス 2 本を同時起動する E2E 確認は行っていない(ユニット/統合テストのみ)。
  非 Linux 環境では `procStartToken` が取れず PID 使い回しで誤って拒否する可能性が残るが、
  `--force` で回避できる。
- 次の試行への提案: 追加作業は不要。関連箇所を触る場合は上記 decision の判定方針を先に読むこと。
