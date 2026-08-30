---
title: "マージ衝突の再試行が必ずまた衝突し、タスクのやり直し回数を使い切る"
status: failed
priority: 2
dependencies: []
retries: 3
note: "失敗回数が上限(3)に達した。最後の失敗: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0621-conflict-retry-always-reconflicts.md)(元: 失敗のため ready に戻す(2/3)。理由: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks…)"
createdAt: 2026-08-30T06:21:28.294Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間への確認は取らずに進めてよい。

## 何が起きているか

`T-20260830-0537-max-turns-not-failure` は、**3 回の試行がすべて main へのマージ衝突で失敗**して
`failed` になった。実装は 1 回目で完成していたにもかかわらず、一度も main に入らないまま
やり直し回数(上限 3)を使い切った。衝突したファイルは 3 回とも同じで、
`CHANGELOG.md` とそのタスク自身のタスクファイルである(タスクファイル本文の `## 試行履歴` に
Supervisor が残した記録から確認できる)。

## なぜ繰り返すのか(仮説。実装で裏を取ること)

衝突が「解消されたのにまた起きる」構造になっている疑いがある。

1. **タスクファイル**: 衝突で試行が失敗すると、Supervisor は main 側のタスクファイル末尾の
   `## 試行履歴` に新しい試行エントリを追記する。一方、衝突解消セッションが動く worktree の
   ブランチ側も同じファイルの同じ末尾付近を編集している。次の試行でマージすると、
   **両側が同じ場所に追記した状態**になり再び衝突する。つまり失敗を記録する行為そのものが
   次の衝突を生んでいる。
2. **CHANGELOG.md**: 「## 未リリース」節の先頭に 1 行足す運用なので、並走する他のタスクが
   先に main へ入るたびに同じ行が競合する。試行のたびに main が進むため、解消しても次の
   試行までにまた競合する。

いずれも「解消の腕前」の問題ではなく、待てば待つほど不利になる構造の問題である。
やり直し回数はタスクの難しさに対する安全網のはずが、マージ機構の都合で消費されている。

## 実害

- 完成した成果が main に入らないまま `failed` になり、衝突ブランチと退避パッチにだけ残る。
  片付け処理がそれらを消せば成果は失われる。
- 人間が `ccloop status` で見るのは「3 回失敗した」という結果だけで、**作業自体は成功していた**
  ことが分からない。原因の切り分けに時間がかかる。
- 費用の面でも、同じ作業をやり直さずに済んだはずの試行を 2 回ぶん無駄にしている。

## やること

1. 上の 2 つの仮説を実際に確かめる(`/tmp` に使い捨てリポジトリを作り、追記と 3-way マージの
   組み合わせを再現するのが手早い)。裏が取れた仮説だけを直す対象にする。
2. **タスクファイルの試行履歴が衝突源にならないようにする。** 案は複数ありうる:
   - 衝突で失敗した試行の記録を、ブランチ側とぶつからない形で書く
   - 試行履歴をタスクファイル本文ではなく別ファイルに持つ
   - タスクファイルに限りマージ方針を決め打ちにする(既に
     `D-20260830-0544-task-file-conflict-match-main` で「main 側を優先」の判断がある)
   どれを選ぶかは実装時に判断し、理由を `.agent/decisions/` に記録する。
3. **マージ衝突による失敗が、タスク本来のやり直し回数を消費しないようにするか**を検討する。
   時間切れやクラッシュと違い、衝突はタスクの中身の失敗ではない。レートリミットが
   `retries` を消費しない先例(`lib/ratelimit.ts` まわりの設計)があるので、それに倣えるか見る。
   ただし無制限に再試行すると永久に衝突し続ける恐れがあるため、別枠の上限を設けるなどの
   歯止めは要る。
4. `CHANGELOG.md` の競合については、既に
   `D-20260830-0531-changelog-merge-keep-both-entries`(両側を残す)の判断がある。
   この方針が自動で適用されるようにできるか(`.gitattributes` のマージ方針指定など)を検討する。
   できないなら、少なくとも衝突解消セッションへの申し送りでこの判断を明示的に示す。
5. テストを足す。少なくとも「衝突で失敗した試行の記録が、次のマージで再び衝突しないこと」は
   自動で確かめられる形にする。
6. 利用者から見た挙動が変わるので `CHANGELOG.md` の「## 未リリース」に 1 行足す。

## 完了条件

同じ状況(main が進みながら衝突解消を繰り返す)で、やり直し回数を使い切らずに成果が main へ
入るようになっていること。機械的検証が通ること。

## 関連

- 取り残された成果の救出は `T-20260830-0621-rescue-max-turns-work` が別途行う。本タスクは
  再発防止だけを扱う。両者は同じファイル(`lib/supervisor.ts`)に触れる可能性があるので、
  救出が先に main へ入ってから着手するのが望ましい。

## 試行履歴

### 試行 1(2026-08-30T07:58:07.813Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, CHANGELOG.md, lib/supervisor.finish.test.ts)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 2(2026-08-30T08:13:38.210Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0621-conflict-retry-always-reconflicts.md, CHANGELOG.md, docs/architecture.md, lib/supervisor.test.ts, lib/supervisor.ts)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 3(2026-08-30T08:23:29.090Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0621-conflict-retry-always-reconflicts.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
- 未コミット差分を `/home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z.patch` へ退避した(`CHANGELOG.md`, `lib/ratelimit.test.ts`, `lib/ratelimit.ts`, `lib/supervisor.finish.test.ts`, `lib/supervisor.ts`)。復元は `git apply /home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z.patch`
- コミット済みの成果はブランチ `agent/conflict/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z` に退避した(削除していない)
