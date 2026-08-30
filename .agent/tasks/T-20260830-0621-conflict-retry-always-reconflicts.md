---
title: "マージ衝突の再試行が必ずまた衝突し、タスクのやり直し回数を使い切る"
status: failed
priority: 2
dependencies: []
retries: 3
note: "3 回ともマージ衝突で失敗し failed。ただし成果は T-20260830-0825-rescue-conflict-retry-work が main へ取り込み済み"
createdAt: 2026-08-30T06:21:28.294Z
updatedAt: 2026-08-30T08:13:38.542Z
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

### 試行 1(2026-08-30T07:47:40.000Z, セッション記録)
- 確認済みの事実: 仮説を実験で裏取りした。両側が同じ挿入点へ追記すると正しい 3-way マージでも
  必ず衝突し、解消しても main が進めば再発する。`.gitattributes` の `merge=union` を効かせると
  衝突せず両側が残る(union はマージ実行側のツリー = main に存在して初めて効く)。
- 確認済みの事実: 真因は `classifyConflicts`(lib/merge.ts:124)が「衝突パスが担当タスクファイルと
  `.agent/decisions/index.md` だけ」のときしか機械解決せず、他のパスが 1 つでも混ざると全体を
  substantive に倒すこと。CHANGELOG.md が混ざったせいでタスクファイル分まで手作業に回っていた。
- 確認済みの事実: コミット 630f914 で `.gitattributes`(`/CHANGELOG.md merge=union`)、
  `conflictResolutionSection` への申し送り追加、`docs/architecture.md` の節追加、判断記録 2 件
  (D-20260830-0745 / D-20260830-0746)を入れた。`npm run typecheck` と
  `npx vitest run lib/supervisor.test.ts`(373 件)が通ることを確認済み。
  `git check-attr merge` で union が CHANGELOG.md にのみ効くことを確認済み。
- 次の試行への提案: 残りは「マージ衝突を retries と別枠にする」実装(`conflictRetries` /
  `maxConflictRetries` 既定 5)。方針は D-20260830-0745 に確定済みなのでそこから始めること。

### 試行 1 の続き(2026-08-30T07:57:40.000Z, セッション記録)
- 確認済みの事実: コミット f6bf85b で衝突リトライの別枠化を実装した(`Task.conflictRetries` /
  `config.maxConflictRetries` 既定 5、schemaVersion 2 への移行、`ccloop retry` の両カウンタリセット、
  `ccloop status` の `衝突=N` 表示)。モデルエスカレーション判定は `retries` のみのまま。
- 確認済みの事実: コミット 0f57a7b でレビュー指摘(変更履歴への追記漏れ、解消方針の使い分けが
  未明文化)に対応した。
- 確認済みの事実: `npm run typecheck` / `npm run lint` / `npx vitest run`(31 ファイル 1029 件)が
  すべて通ることを最終状態で確認済み。reviewer は 630f914 に対し REQUEST_CHANGES(変更履歴の
  追記漏れ)を出し、0f57a7b で解消した。
- 未検証の推測: `maxConflictRetries` は既存の `.agent/config.json`(schemaVersion 1)を壊さないよう
  `checkInt` の必須検証ではなく既定値補完(`triage` / `parallel` と同じ流儀)にしてある。
  `ccloop init --upgrade` 経由の移行は実リポジトリでは未実行。

### 試行 1(2026-08-30T07:58:07.813Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, CHANGELOG.md, lib/supervisor.finish.test.ts)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 2(2026-08-30T08:10:03.708Z, セッション記録)
- 確認済みの事実: main とのマージ衝突 2 件を解消しコミット 4fcfcde を作った。
  `.agent/decisions/index.md` は両側の新規項目 4 件を ID 降順で残した(捨てた項目は無い)。
  `lib/supervisor.finish.test.ts` は main 側が追加したテスト (c') をそのまま取り込み、
  (d) はブランチ側の衝突リトライ上限版の題名・本文を採用した。CHANGELOG.md は
  `.gitattributes` の union 属性により衝突せず両側の項目が残った(本タスクの成果が
  実際に効いたことの実地確認になっている)。
- 確認済みの事実: reviewer が観点 A(マージ解消)を APPROVE、観点 B で「やること」項目 5
  (回帰テスト)の未達を指摘した。コミット d6f5c35 で `lib/merge.test.ts` に 2 件追加して解消した。
  1 件目は「タスクファイルの試行履歴追記 + CHANGELOG.md の両側追記」が同時に起きても
  `renumbered`(機械的解決)になることを確認する。2 件目は対照で、`.gitattributes` が無いと
  同じ状況が `conflict`(conflictKind: substantive)になることを確認する。union 属性が
  効いていること自体がテストで固定された。
- 確認済みの事実: 最終状態で `npm run typecheck` / `npm run lint` / `npm test`
  (31 ファイル 1054 件)が通ることを確認済み。
- 確認済みの事実: own-task-file の機械的解決は「ブランチ側を丸ごと採用」であり、両側の内容を
  マージするわけではない(追加したテストで実挙動として確認)。つまり衝突時、main 側の
  タスクファイルへ Supervisor が書いた試行履歴エントリは失われる。実害は小さいが、
  この挙動を前提に読むこと。
- 確認済みの事実: 作業中に `.agent/decisions/index.md` へ未掲載の決定記録が 9 件あることを
  発見した。承認の導線を素通りする問題なので、本タスクでは直さず
  `T-20260830-0810-decisions-index-missing-entries` として登録した。
- 確認済みの事実: 本セッションはタスクファイルを main へ寄せず `## 試行履歴` を残したまま終える。
  `docs/architecture.md:241-253` の「main へ寄せよ」という指示は衝突が `retries` を食い潰す前提の
  防御策であり、その前提が本タスクで無くなったため。判断は `D-20260830-0812` に記録した。

### 試行 2(2026-08-30T08:13:38.210Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0621-conflict-retry-always-reconflicts.md, CHANGELOG.md, docs/architecture.md, lib/supervisor.test.ts, lib/supervisor.ts)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 3(2026-08-30T08:13:38.542Z, セッション記録)

- 確認済みの事実: 3 回目の衝突は前回と別物で、main に並走タスク 2 件(分割ヒント、探索時の片付け)が
  入ったことによる実質的な衝突だった。`retryContextSection` は両側が同じ関数を書き換えていたため、
  衝突リトライ別枠カウント(ブランチ側)と分割ヒントの lines 配列化(main 側)を統合して解消した。
  `lib/supervisor.test.ts` / `docs/architecture.md` / `.agent/decisions/index.md` は両側の追加を両方残した。
- 確認済みの事実: main 側の機械記録(retries: 2、試行 1・2 の Supervisor 記録)をブランチ側へ
  取り込んだ(own-task-file の機械的解決はブランチ側を丸ごと採用するため、取り込まないと失われる)。
- 確認済みの事実: マージ基点 c20ae88 以降の main の前進は自タスクファイルのみ(git diff --stat で確認)。
  よって最終マージで再衝突しうるのは own-task-file だけで、インストール版 0.4.1 でも機械解決される。

### 試行 3(2026-08-30T08:23:29.090Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0621-conflict-retry-always-reconflicts.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
- 未コミット差分を `/home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z.patch` へ退避した(`CHANGELOG.md`, `lib/ratelimit.test.ts`, `lib/ratelimit.ts`, `lib/supervisor.finish.test.ts`, `lib/supervisor.ts`)。復元は `git apply /home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z.patch`
- コミット済みの成果はブランチ `agent/conflict/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z` に退避した(削除していない)

### 救出(2026-08-30, T-20260830-0825-rescue-conflict-retry-work のセッション記録)

- 確認済みの事実: 退避ブランチのコミット済み成果一式を
  `T-20260830-0825-rescue-conflict-retry-work` のブランチへ取り込んだ。`status` は `failed` のまま
  (実際に 3 回失敗した事実を残すため)。以降このタスクを再実行する必要はない。
