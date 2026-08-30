---
title: "作業中の git 操作を検出する安全弁の未検証な条件をテストで固める"
status: completed
priority: 3
dependencies: []
retries: 0
note: "REVERT_HEAD / BISECT_LOG / rebase-merge の 3 条件を実操作で再現するテストを追加。実装は不備なしで変更不要だった"
createdAt: 2026-08-30T13:54:37.114Z
---

所属フェーズ: 4(思いつく改善すべて)。テストの追加に当たるため人間の確認は不要
(`D-20260830-0303-phase4-consent-granularity` の「確認を取らない」側)。

## 目的

`lib/worktree.ts:214-220` の `gitOperationInProgress` は、merge / cherry-pick / revert / bisect /
rebase のいずれかが進行中かを 6 条件(`MERGE_HEAD`・`CHERRY_PICK_HEAD`・`REVERT_HEAD`・`BISECT_LOG`
のファイル存在、`rebase-merge`・`rebase-apply` のディレクトリ存在)で判定する。
このうち **`REVERT_HEAD` / `BISECT_LOG` / `rebase-merge` / `rebase-apply` の 4 条件を実際に
再現して検証しているテストが 1 件も無い**(探索セッションが `lib/*.test.ts` を全数 grep して確認。
`git revert` / `git bisect` / `git rebase` を使うテストが存在しない)。検証済みなのは `MERGE_HEAD`
(`lib/worktree.test.ts` の `describe("mergeInProgress / gitOperationInProgress", ...)`)と
`CHERRY_PICK_HEAD`(`lib/supervisor.test.ts` の `worktreeConflictPending` 経由のケース)だけである。

この関数は「人間や別処理が進行中の git 操作を、ループが横取りして壊さない」ための安全弁として
広く使われている: `lib/merge.ts:582`(自動マージの entry guard)、`lib/supervisor.ts:909`
(`.agent/` の自動コミット)、同 `1426`(衝突解消待ちの検出)、同 `3777` / `4242` / `4375`
(復旧・再試行の割り込み防止)。誤って「進行中でない」と返すと、進行中の作業を壊す方向に倒れる。

ファイル存在とディレクトリ存在という型の違いも混在しており、`gitPath` の解決や `fs.existsSync` の
対象をリファクタで崩しても、既存テストが通る 2 条件だけでは検知できない。

## 対象

- `lib/worktree.test.ts` にテストを追加する(既存の `describe("mergeInProgress / gitOperationInProgress", ...)`
  の中が素直な追加先)。新規ヘルパーは不要で、既存のリポジトリ初期化ヘルパーを流用できる。
- 実装(`lib/worktree.ts`)は現状で正しいと考えられるため、変更は想定していない。テストを追加して
  実装が変わっていないことを確認するのが目的。もしテスト作成中に実装の不備が見つかった場合は
  実装も直し、その根拠を `.agent/decisions/` に記録する。

## 完了条件

- `REVERT_HEAD` / `BISECT_LOG` / `rebase-merge`(または `rebase-apply`)の各状態を実際の git 操作で
  再現し、`gitOperationInProgress` が `true` を返すことを検証するテストが追加されている。
  `git revert` は衝突させて `REVERT_HEAD` を残す、`git bisect start` 系は `BISECT_LOG` を残す、
  `git rebase` は衝突させて `rebase-merge` を残す、という形で状態を作る。
- 進行中の操作が何も無いときに `false` を返すことも併せて検証されている(既存テストにあれば流用でよい)。
- テスト内で作った git 状態は後始末する(他のテストに漏れないこと)。
- `npm test` / `npm run lint` / `npm run typecheck` が通る。

## 補足(着手セッションへの申し送り)

- `rebase-apply` は `git rebase --apply`(または `git am`)経由でしか作られず、既定の rebase では
  `rebase-merge` になる。両方を無理に再現しようとせず、少なくとも一方を検証すれば目的は満たせる。
  片方だけにした場合は、その理由をテストのコメントに 1 行残すこと。
- `gitOperationInProgress` は linked worktree(`.git` がファイルになる)でも動くことを狙って
  `gitPath` を使っている(実装のコメント参照)。linked worktree 上での検証も 1 ケース入れられると
  この関数が存在する理由そのものを守れるが、必須ではない。
- 利用者から見た挙動は変わらないため、`CHANGELOG.md` には載せない(テストの追加は非掲載)。
