---
updatedAt: 2026-08-30T03:18:17.730Z
completed: 7
total: 14
---

# OVERVIEW(GOAL に対する現在地)

GOAL の「現在の目標」1 つ目(decisions アーカイブの人間承認化、`ccloop status` への未承認決定の
表示)は完了済み。2 つ目の「人間の確認・介入の導線を磨く」も、足りない機能を作る段階は概ね
抜けている。いま残っているのは次の 3 種類である。

## 1. 導線が手元に届いていない(最大の綻び)

`ccloop` の実体はインストール先のコピーであり、リポジトリの `lib/` を直しても入れ替えるまで
人間の手元の挙動は変わらない。入れ替え手順は README にも docs にも書かれていない。公開版 0.4.1 から
未公開の変更が積み上がっている。
→ `HR-20260830-0303-topic-local-ccloop-update`(要回答)
→ 変更履歴の有無は `HR-20260830-0303-topic-changelog-release-notes`(要回答)

## 2. 検証の信頼性(いま最も手を入れている領域)

- GOAL の制約「deny リストと PROMPT.md の絶対ルールを常に一致させる」に検証手段が無い
  (`T-20260830-0259-deny-list-prompt-consistency-test`、対応中)。
- テストの無い hook が 3 つ残っている(`T-20260830-0254-hook-scripts-regression-tests`、対応中)。
- **セッション終了時の後始末(マージ結果 × 実行結果 × マージ中断の十数分岐)に直接のテストが
  1 件も無い**(`T-20260830-0318-finish-task-session-wiring-tests`)。壊れると main や
  コミット済みの成果を失いうる箇所であり、検証の空白としては現状で最も大きい。
  個々の純粋関数は切り出されテスト済みで、未検証なのはそれらを組み合わせる配線である。

## 3. 実装・仕様書・ヘルプの食い違い

- `.agent` の自動コミットをスキップする際、自分が加えたステージを戻さないため、人間の
  インデックスに `.agent/` の変更が残る(`T-20260830-0318-commit-agent-dir-unstage-on-skip`)。
  「人間の並行作業を保護する」という設計意図と逆の結果になっている。
- 探索セッションへ注入する指示文が、チェックボックス方式より前の `対応:` マーカー表記のまま
  (`T-20260830-0318-explore-prompt-answer-marker`)。Stage 2 が持つ「回答はあるが新規タスクは
  不要」の受け皿も文面に無い。
- worktree 側の git 操作中断の検出範囲が本体側より狭く、判定不能時の安全側倒しも効いていない
  (`T-20260830-0318-worktree-git-operation-detection`、影響は限定的なので優先度は低い)。
- `ccloop add` のエラー文言と `lib/help.ts` のコメントの不一致
  (`T-20260830-0309-cli-usage-string-mismatch`、対応中)。

なお `lib/prompt/PROMPT.md` と実装の突き合わせを一通り行った結果、記録ファイルの ID 形式・
frontmatter の扱い・Human Review 取り込み 3 段階・archive ローテーション・パッチ退避・
フェーズゲート運用については食い違いが無いことを確認した。

## フェーズ

- 現在フェーズ: **4(思いつく改善すべて)**。フェーズ 1〜3 の遡及確認とフェーズ 4 の運用可否を
  集約した `HR-20260830-0236-phase-gate-applicability` は回答済み・closed。回答は
  「改善のネタごとに確認をとって。粒度はユーザーに対するリリースノートに記載する粒度と同程度に」。
- 確認の線引きは `.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` に記録済み。
- 回答待ちのトピック確認(いずれも BLOCK、上限の 4 件に達しているため新規は開けない):
  - `HR-20260830-0303-topic-local-ccloop-update` — 手元の ccloop を入れ替える手順
  - `HR-20260830-0303-topic-changelog-release-notes` — 変更履歴を残す仕組み
  - `HR-20260830-0309-topic-status-more-context` — status に確認事項の要約・スヌーズ理由を出す
  - `HR-20260830-0309-topic-run-process-liveness` — ループが生きているかを status で示す
- 枠が空き次第、次に確認したい候補:
  - failed / blocked タスクの再実行が frontmatter の手編集必須。`ccloop retry <id>` 相当の
    サブコマンドを用意するか(README.md:97-99)。
  - タスクに `updatedAt` が無く、失敗・停止から何日経ったかが status から分からない
    (`lib/supervisor.ts:120-137`。スキーマ変更を伴うため作業量は大)。
- 回答待ちの間も、検証強化と不具合修理・表記不一致の解消は確認不要としてタスク化済みであり、
  ループは手待ちにならない。
