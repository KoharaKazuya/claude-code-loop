---
title: "退避ブランチに取り残された「後始末の中断復旧」の実装を main へ取り込む"
status: ready
priority: 1
dependencies: []
retries: 0
createdAt: 2026-08-30T10:53:39.546Z
---

所属フェーズ: 4(思いつく改善すべて)。取り残された成果の救出なので人間への確認は不要。

## 何が起きているか

`T-20260830-0829-finish-crash-leaves-no-trace`(後始末の中断で成果が痕跡なく消える問題の修理)が
3 回ともマージ衝突で失敗し `failed` になった。**完成した実装は main に入っておらず**、退避ブランチ

    agent/conflict/T-20260830-0829-finish-crash-leaves-no-trace-20260830T101839Z

にだけ存在する。このブランチが消えると成果が失われる。

`git log main..<branch>` で確認できるコミット(4 件):

- `8d979b2` fix(supervisor): 後始末の中断で痕跡なく未着手へ戻る経路を塞ぐ
- `bfecde7` fix(supervisor): 後始末の中断復旧が正当な ready 再投入を誤検知しないようにする
- `12b14c0` Merge commit '923d418…'(main の取り込み)
- `4c1fec3` fix(supervisor): main の分類純関数化と後始末中断復旧の変更を統合する

`git diff --stat main...<branch>` の内容:

    .agent/decisions/D-20260830-0945-finish-interrupt-recovery-approach.md |  46 ++
    .agent/tasks/T-20260830-0829-finish-crash-leaves-no-trace.md           |  12 +-
    CHANGELOG.md                                                           |   3 +
    lib/supervisor.finish.test.ts                                          |  55 ++
    lib/supervisor.test.ts                                                 | 134 ++++
    lib/supervisor.ts                                                      |  92 ++-

## やること

1. 退避ブランチの差分を読み、main の現状(`lib/supervisor.ts` はこの間も他タスクで変更されている)と
   突き合わせる。**単純なマージは 3 回とも衝突しているので、差分を読んで手で当て直す前提で臨むこと。**
   衝突の中心は `lib/supervisor.ts` と `.agent/tasks/T-20260830-0829-...md` である。
2. 中断復旧の実装(後始末の 3→4 の間で死んでも痕跡が残るようにする変更)と、そのテストを
   main の現行コードへ取り込む。採用した設計は退避ブランチ内の
   `.agent/decisions/D-20260830-0945-finish-interrupt-recovery-approach.md` に記録されているので、
   まずそれを読むこと(main には存在しない)。この判断記録も一緒に main へ持ってくる。
3. `CHANGELOG.md` の「## 未リリース」への 1 行も取り込む(既に同趣旨の行があれば重複させない)。
4. 機械的検証(`npm run` のテスト・lint・typecheck)を通す。
5. 取り込みが完了したら `T-20260830-0829-finish-crash-leaves-no-trace` の `note` に
   「成果は本タスクが main へ取り込み済み」と追記する(`status: failed` のままでよい。
   failed からの復帰は `T-20260830-1002-failed-task-abandon-flow` の担当範囲)。

## 参考(退避パッチ)

同じ試行で、コミットされなかった作業ツリー差分がパッチとして退避されている。

    /home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0829-finish-crash-leaves-no-trace-20260830T101839Z.patch

ただしこれは**衝突解消の途中で中断された作業ツリー**の差分であり、`lib/merge.ts` /
`docs/architecture.md` / `lib/prompt/PROMPT.md` など、退避ブランチのコミットには含まれない
ファイルが混ざっている。これらは衝突マージで取り込まれた main 側の変更である可能性が高い。
**パッチを無条件に `git apply` しないこと。** 一次資料は退避ブランチのコミットであり、
パッチは「ブランチのコミットに無い改善が含まれていないか」を確認する二次資料として扱う。

## 完了条件

退避ブランチのコミットに含まれる実装・テスト・判断記録・変更履歴が main に入り、機械的検証が通ること。
取り残しが無いことを `git diff main...<branch>` で確認したうえで、残った差分(取り込まない判断を
したもの)があればその理由を `.agent/decisions/` に記録すること。

## 注意

退避ブランチの削除はセッションの権限外(人間の操作)。**削除を試みないこと。**
取り込み完了後、`ccloop status` の「退避された衝突ブランチ」に残り続けるが、それは人間が消す。
