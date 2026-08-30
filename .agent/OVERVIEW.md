---
updatedAt: 2026-08-30T03:09:29.734Z
completed: 6
total: 10
---

# OVERVIEW(GOAL に対する現在地)

GOAL の「現在の目標」1 つ目(decisions アーカイブの人間承認化、`ccloop status` への未承認決定の
表示)は完了済み。2 つ目の「人間の確認・介入の導線を磨く」も、機能面では
`lib/prompt/PROMPT.md` の仕様と実装の間に食い違いがほぼ無いところまで来ている。
つまり「作るべき機能が足りない」段階は概ね抜けている。いま残っているのは次の 3 種類である。

## 1. 導線が手元に届いていない(最大の綻び)

`ccloop` の実体はインストール先のコピーであり、リポジトリの `lib/` を直しても入れ替えるまで
人間の手元の挙動は変わらない。入れ替え手順は README にも docs にも書かれていない。公開版 0.4.1 から
未公開の変更が 27 コミット分たまっている。
→ `HR-20260830-0303-topic-local-ccloop-update`(要回答)
→ 変更履歴の有無は `HR-20260830-0303-topic-changelog-release-notes`(要回答)

## 2. 検証の信頼性

- GOAL の制約「deny リストと PROMPT.md の絶対ルールを常に一致させる」に検証手段が無い
  (`T-20260830-0259-deny-list-prompt-consistency-test`、対応中)。
- テストの無い hook が 3 つ残っている(`T-20260830-0254-hook-scripts-regression-tests`、対応中)。
- 自己ホスト環境で親セッションの `CLAUDE_AGENT_*` が子プロセスへ漏れる問題は解消済み。
- 今回の探索で `npm test`(767 件)/ `typecheck` / `lint` がすべて通ることを確認した。

## 3. 仕様書・ヘルプと実装の表記不一致

- 機械追記の見出し(仕様書は「ccloop 記録」、実装は「Supervisor 記録」)
  (`T-20260830-0259-attempt-record-label-mismatch`、対応中)。
- `ccloop add` のエラー文言が内部モジュール名 `supervisor.ts` を名乗る、`lib/help.ts` のコメントが
  存在しない `help.test.ts` を参照している(`T-20260830-0309-cli-usage-string-mismatch`)。

## フェーズ

- 現在フェーズ: **4(思いつく改善すべて)**。フェーズ 1〜3 の遡及確認とフェーズ 4 の運用可否を
  集約した `HR-20260830-0236-phase-gate-applicability` は回答済み・closed。回答は
  「改善のネタごとに確認をとって。粒度はユーザーに対するリリースノートに記載する粒度と同程度に」。
- 確認の線引きは `.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` に記録済み。
- 回答待ちのトピック確認(いずれも BLOCK、上限の 4 件に達している):
  - `HR-20260830-0303-topic-local-ccloop-update` — 手元の ccloop を入れ替える手順
  - `HR-20260830-0303-topic-changelog-release-notes` — 変更履歴を残す仕組み
  - `HR-20260830-0309-topic-status-more-context` — status に確認事項の要約・スヌーズ理由を出す
  - `HR-20260830-0309-topic-run-process-liveness` — ループが生きているかを status で示す
- 枠が空き次第、次に確認したい候補(今回の調査で挙がったが上限のため見送り):
  - failed / blocked タスクの再実行が frontmatter の手編集必須。`ccloop retry <id>` 相当の
    サブコマンドを用意するか(README.md:97-99)。
  - タスクに `updatedAt` が無く、失敗・停止から何日経ったかが status から分からない
    (`lib/supervisor.ts:120-137`。スキーマ変更を伴うため作業量は大)。
- 回答待ちの間も、検証強化と表記不一致の解消は確認不要としてタスク化済みであり、
  ループは手待ちにならない。
