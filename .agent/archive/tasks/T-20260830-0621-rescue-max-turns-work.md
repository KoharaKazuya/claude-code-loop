---
title: "衝突ブランチに取り残されたターン上限の修正を main へ取り込む"
status: completed
priority: 1
dependencies: []
retries: 0
note: "5 ファイルを main へ取り込み検証済み。衝突ブランチ agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z は取り込み済みなので人間が削除してよい"
createdAt: 2026-08-30T06:21:28.294Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理と、既に完成している成果の救出なので
人間への確認は取らずに進めてよい。

## 何が起きているか

`T-20260830-0537-max-turns-not-failure`(p2)は **3 回の試行すべてが main へのマージ衝突で
失敗**し、`failed` になった。作業そのものは失敗していない。実装・テスト・文書・判断記録まで
完成しており、ブランチ
`agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z`
にコミット済みのまま取り残されている。main には一切入っていない
(`lib/supervisor.ts` に `is_error` を見る分類は無く、`--max-turns` の参照は引数の組み立てだけ)。

このままだと、ターン数の上限で打ち切られたセッションが失敗として数えられない不具合
(`retries` が増えず `failed` にもならず、同じタスクが無限に選ばれ続ける)が残り続ける。
さらに衝突ブランチと退避パッチは片付け処理の対象なので、放置すると成果ごと消える恐れがある。

## ブランチに入っているもの

`git diff --stat main...agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z`
で確認できる。取り込むべきは次の 5 ファイル:

- `lib/supervisor.ts`(ターン上限を失敗として分類する本体)
- `lib/supervisor.finish.test.ts`(テスト)
- `CHANGELOG.md`(「## 未リリース」への 1 行)
- `docs/compatibility.md`
- `.agent/decisions/D-20260830-0546-is-error-treated-as-failure.md`(判断記録)

取り込まなくてよいもの: `.agent/OVERVIEW.md`、`.agent/decisions/index.md`、
`.agent/tasks/T-20260830-0537-max-turns-not-failure.md`、
`.agent/decisions/D-20260830-0611-own-task-file-keep-branch-record.md`
(いずれも当時の運用記録で、現在の main の内容が正しい)。

## やること

1. **ブランチ操作は使えない**(`git merge` / `checkout` / `switch` / `cherry-pick` 相当の
   ブランチ切り替えは permissions の deny 対象)。パッチ経由で取り込むこと:

   ```
   git diff main...agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z \
     -- lib/supervisor.ts lib/supervisor.finish.test.ts CHANGELOG.md docs/compatibility.md \
        .agent/decisions/D-20260830-0546-is-error-treated-as-failure.md > /tmp/max-turns.patch
   git apply /tmp/max-turns.patch
   ```

   main はブランチが切られた後も進んでいる(`config.json` の項目検証、探索セッション起動失敗の
   修正などが入った)。`lib/supervisor.ts` で当たる可能性があるので、`git apply` が失敗したら
   `git apply --3way` を試し、それでも駄目なら該当箇所を手で当て直す。**取り込む内容を減らして
   通す**のは駄目で、実装・テスト・文書がすべて入った状態にすること。

2. 当て直した場合は、元の意図(ターン上限による打ち切りを失敗として数え、時間切れと区別できる
   文言にする。レートリミット判定より後ろに置く)が保たれているかを
   `.agent/decisions/D-20260830-0546-is-error-treated-as-failure.md` の内容と突き合わせて確認する。

3. 機械的検証(typecheck / lint / test)を通す。特に `lib/supervisor.finish.test.ts` の
   既存の成功ケースを壊していないこと。

4. `CHANGELOG.md` の「## 未リリース」に該当行が入っていることを確認する
   (パッチが当たらず手で書く場合、既存の行と重複させない)。

5. 取り込みが済んだら `.agent/tasks/T-20260830-0537-max-turns-not-failure.md` の
   `status` を `completed` に、`note` を「成果は T-20260830-0621-rescue-max-turns-work で
   main へ取り込んだ(試行 3 回はいずれもマージ衝突による失敗)」に更新する。`## 試行履歴` は
   消さずに残す(失敗の経緯はそこに残る)。

6. 衝突ブランチ `agent/conflict/...` の削除はしないこと(ブランチ削除は deny 対象)。
   取り込み済みである旨を本タスクの `## 試行履歴` に書けば、後で人間が消せる。

## 完了条件

main に上記 5 ファイル相当の変更が入り、検証が通り、コミットされていること。

## 関連

- 3 回とも同じ理由で衝突した構造的な原因は `T-20260830-0621-conflict-retry-always-reconflicts`
  で扱う。本タスクは取り残された成果の救出だけを行う。

## 試行履歴

### 試行 1(2026-08-30T07:31:30Z, セッション記録)
- 確認済みの事実: `git diff main...agent/conflict/...` で 5 ファイル分のパッチを作り `git apply --3way`
  で取り込んだ。`lib/supervisor.ts` / `lib/supervisor.finish.test.ts` / `docs/compatibility.md` /
  `.agent/decisions/D-20260830-0546-is-error-treated-as-failure.md` は無衝突。`CHANGELOG.md` のみ
  「## 未リリース」節末尾で衝突したため、両側の追加行を両方残す形で手で解消した。
- 確認済みの事実: `git diff agent/conflict/... -- <上記 4 ファイル>` にターン上限関連の差分は無く、
  元ブランチと内容が一致している。`npm run typecheck` / `npm run lint` / `npm test`
  (31 files / 1018 tests)すべて成功。
- 確認済みの事実: 元ブランチの `.agent/decisions/index.md` にあった行は取り込み対象外だったため、
  D-20260830-0546 の行を手で追記した。
- 次の試行への提案: 衝突ブランチ
  `agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z` の内容は main へ
  取り込み済みなので、人間が削除してよい(セッションはブランチ削除ができない)。
