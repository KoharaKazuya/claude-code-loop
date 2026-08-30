---
title: "衝突ブランチに取り残された「衝突リトライ別枠化」の成果を main へ取り込む"
status: completed
priority: 1
dependencies: []
retries: 0
note: "退避ブランチのコミット済み成果一式を 3-way マージで統合。typecheck / lint / テスト(1077 件)通過"
createdAt: 2026-08-30T08:25:02.024Z
updatedAt: 2026-08-30T09:23:49.767Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間への確認は取らずに進めてよい。

## 何が起きているか

`T-20260830-0621-conflict-retry-always-reconflicts`(マージ衝突の再試行が必ずまた衝突する問題の
修正)は、**3 回の試行がすべて main へのマージ衝突で失敗**し `failed` になった。皮肉なことに、
そのタスクが直そうとしていた不具合そのものに殺された形である。

ところが**実装は完成している**。成果はブランチ
`agent/conflict/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z` に
コミット済みで残っている(11 コミット、22 ファイル、+893/-65 行)。main には一切入っていない。

このままだと片付け処理がブランチを消した時点で成果が失われ、同じ実装をやり直すことになる。
先例として `T-20260830-0621-rescue-max-turns-work` が同じ救出を行っており、手順はそれに倣える。

## ブランチに入っているもの(確認済み)

- `feat: マージ衝突のリトライをタスク本来の retries と別枠にする`(`lib/supervisor.ts` /
  `lib/config.ts` / `lib/migrations.ts` / `lib/templates/agent/config.json`)
- `fix(merge): CHANGELOG の衝突を union マージで自動解決する`(`.gitattributes` / `lib/merge.ts` 周辺)
- 回帰テスト(`lib/merge.test.ts` +157 行、`lib/supervisor.test.ts` +223 行、
  `lib/supervisor.finish.test.ts`、`lib/config.test.ts`、`lib/migrations.test.ts`)
- 文書(`CHANGELOG.md` / `README.md` / `docs/architecture.md` / `docs/compatibility.md` / `lib/help.ts`)
- 判断記録 3 件(`D-20260830-0745-conflict-retry-separate-budget` /
  `D-20260830-0746-changelog-union-merge` / `D-20260830-0812-keep-attempt-history-after-fix`)
- ブランチ上で新規登録されたタスク 1 件
  (`T-20260830-0810-decisions-index-missing-entries`。main には存在しない)

さらに、最後の試行の未コミット差分がパッチとして退避されている
(`CHANGELOG.md` / `lib/ratelimit.ts` / `lib/ratelimit.test.ts` / `lib/supervisor.ts` /
`lib/supervisor.finish.test.ts`)。退避先のパスは
`T-20260830-0621-conflict-retry-always-reconflicts` の `## 試行履歴` 試行 3 に記録されている。

## やること

1. ブランチの内容と現在の main の差分を確認する。**main 側にはこのブランチが分岐した後に
   別タスクの成果が入っている**(`ratelimit-hidden-by-timeout` / `background-run-wording` /
   `housekeeping-on-explore` / `doctor-auth-check` など)。同じファイル、特に
   `lib/supervisor.ts` と `CHANGELOG.md` で重なるので、機械的なコピーではなく内容を読んで統合すること。
2. 退避パッチの中身も確認し、ブランチのコミットに含まれていない有用な変更があれば取り込む。
   含まれている、または不要と判断したなら取り込まなくてよい(判断の理由をコミットメッセージか
   `## 試行履歴` に残す)。
3. 統合した内容を担当ブランチへコミットする。**ブランチ操作(checkout / merge / branch 削除)は
   しない。** 参照は `git show <ブランチ名>:<パス>` や `git diff main...<ブランチ名> -- <パス>` で行う。
4. 機械的検証(typecheck / lint / test)を通す。
5. `T-20260830-0621-conflict-retry-always-reconflicts` の `note` を、成果が本タスクで取り込まれた旨に
   更新する(`status` は `failed` のまま。実際に 3 回失敗した事実は消さない)。
6. `CHANGELOG.md` の「## 未リリース」に、利用者から見た変更(マージ衝突による再試行がタスク本来の
   やり直し回数を消費しなくなったこと、CHANGELOG の衝突が自動解決されること)が
   1 行ずつ載っている状態にする。ブランチ側で既に書かれているので、main 側の記述と重複・矛盾が
   ないよう統合する。

## 完了条件

ブランチにあった実装・テスト・文書・判断記録が main に入り、機械的検証が通ること。
取り込まなかったものがあれば、何をなぜ落としたかが `## 試行履歴` に書かれていること。

## 注意

本タスク自身も同じ衝突の罠にかかりうる(`.agent/decisions/index.md` と自分のタスクファイルが
衝突源になる)。**取り込むブランチにその対策が入っている**ため、対策部分から先に main へ入れて
しまうのが安全である。作業は小さく区切り、まとまるたびにコミットすること。

## 関連

- 先例: `T-20260830-0621-rescue-max-turns-work`(同じ救出を行い完了済み)
- 本タスクが取り込む再発防止の元タスク: `T-20260830-0621-conflict-retry-always-reconflicts`
- 本タスクの完了を待つタスク: `T-20260830-0808-human-task-edit-lost-on-merge`

## 試行履歴

### 試行 1(2026-08-30T09:23:49.767Z, セッション記録)

- 確認済みの事実: 退避ブランチとのマージ基点は c20ae88(ブランチ側が既に main を取り込んだ地点)。
  `git diff c20ae88 <退避ブランチ> | git apply --3way` で統合したところ、実コードは
  `lib/supervisor.ts` を含めすべてクリーンに適用され、衝突したのは
  `.agent/decisions/index.md` / 元タスクファイル / `CHANGELOG.md` の 3 件(いずれも markdown)だけだった。
  ブランチ操作(checkout / merge)は一切していない。
- 確認済みの事実: 衝突の解消方針。決定インデックスは main 側の承認チェック `[x]` を保ったまま
  ブランチ側の新規 3 件を `[ ]` で ID 降順に挿入した(捨てた項目は無い)。元タスクファイルは
  frontmatter を main 側(`status: failed` / `retries: 3`)に寄せ、試行履歴は main 側の Supervisor 記録と
  ブランチ側のセッション記録の両方を時系列順に残した。CHANGELOG は両側の項目を残した。
- 確認済みの事実: 退避パッチ
  (`patches/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z.patch`)は
  全ハンクが既に作業ツリーへ反映済み(`ratelimit-hidden-by-timeout` の成果として main に入っていた)。
  よって取り込むものは無く、落とした有用な変更は無い。
- 確認済みの事実: `npm run typecheck` / `npm run lint` / `npm test`(31 ファイル 1077 件)が通ることを確認。
  コミットは 0f550a0(実装・テスト・文書)と e486bf5(`.agent/` の記録)の 2 件。
- 確認済みの事実: reviewer が観点 A〜E(取りこぼし・3-way 統合の正しさ・やること 5 項目・
  CHANGELOG・記録の整合)をすべて APPROVE。要修正指摘は無し。
- 未検証の推測: `.agent/OVERVIEW.md` は本タスクを未完了として記述したままだが、更新は探索セッションの
  担当であり本タスクの完了条件外と判断して触っていない。
