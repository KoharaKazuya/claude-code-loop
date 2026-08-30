---
updatedAt: 2026-08-30T10:57:26.096Z
completed: 64
total: 77
---

# OVERVIEW(GOAL に対する現在地)

GOAL の「現在の目標」に挙がっていた作業(decisions アーカイブの人間承認化、`ccloop status` への
未承認決定の表示、人間の確認・介入の導線)はいずれも消化済み。以後の前進は、
**フェーズ 4 の確認トピックを人間に投げて枠を回し続けること**と、
**確認不要で拾える修理を掘り当てること**の両輪で決まる。

前回挙げていた「次にループを起動すると設定の版番号が古くて止まる」問題は解消済み
(人間が `ccloop init --upgrade` を実施し、`.agent/config.json` は `schemaVersion: 2`)。

## 今いちばんの懸念: 衝突による成果の取り残しが構造化している

**マージ衝突で `failed` に落ちたタスクが通算 4 件、うち 3 件は完成した成果が退避ブランチに
取り残され、救出タスクを別途起こして人手で当て直している。** 今日また 1 件増えた
(`T-20260830-0829-finish-crash-leaves-no-trace`。救出は
`T-20260830-1053-rescue-finish-interrupt-recovery-work`(p1))。

原因は個々のセッションの不手際ではなく構成にある。**`lib/supervisor.ts` は 5617 行あり、
直近 24 時間で 84 コミットが入る単一のホットスポット**で、表示も後始末も起動時復旧もそこに同居する。
並列 4 セッションが走ればほぼ全員が同じファイルを編集する。

打った手は 2 つ。

- **応急処置(実施済み)**: ぶつかることが分かっているタスク同士に `dependencies` を張って直列化した
  (`D-20260830-1053-serialize-supervisor-hotspot-tasks`)。毎回の探索で張り直す必要がある人力運用。
- **仕組み化(確認中)**: スケジューラ側で同じファイルを取り合うタスクを同時に選ばないようにするか、
  `HR-20260830-1053-topic-conflict-prone-parallelism`(BLOCK)で人間に確認中。
  速さと確実さのどちらを取るかの判断なので勝手に決めない。

## 直列化した 2 本の鎖

- 後始末・起動時復旧の系統(すべて `recoverOrphanBranch` / `finishTaskSession` 周辺を触る):
  `-1053-rescue-finish-interrupt-recovery-work`(p1)
  → `-0934-startup-recovery-crash-leaves-no-trace`(p3)
  → `-1053-startup-recovery-conflict-uses-retries`(p3)
- `ccloop status` の表示の系統:
  `-1007-status-respect-decision-checkbox`(p3)
  → `-1053-status-config-schema-outdated`(p3)
  → `-1053-status-parked-branch-merged-state`(p3)

鎖の途中が `failed` になると後続が待たされるが、その状態は `ccloop status` に出る。
不要になったら `dependencies` を空に戻せばよい(可逆)。

## 鎖の外にある着手待ち

- `-1002-failed-task-abandon-flow`(p2)— `failed` を人間が断念しても要対応から消せない。
- `-0825-dependency-cycle-detection`(p4)— 依存の輪の検出。同意済み(優先度低)。
  **直列化で鎖を増やしたぶん、この機能の価値は上がっている。**
- `-0808-human-task-edit-lost-on-merge`(p4)— 依存先は完了済みで待たされていない。
- `-0825-archived-tasks-read-cap`(p5)— 回答で「優先度は低い」と明示された。

前回の一覧に載っていた `-0810-decisions-index-missing-entries` と
`-0903-merge-abort-retry-racy-git` は完了済み(archive にある)。

## 人間の手が要る残務

- 退避ブランチ `agent/conflict/T-20260830-0829-finish-crash-leaves-no-trace-20260830T101839Z` は
  **まだ削除してはいけない**(唯一の成果の置き場。救出タスクが取り込んでから削除)。
  前回挙げていた取り込み済みの退避ブランチ(T-0537 / T-0621 / T-0808)は削除済みで、
  いま残っている退避ブランチはこの 1 本だけ。
- `failed` の 3 件(`-0621` / `-0808-conflict-session-timeout-mislabeled` / `-0829`)は
  いずれも成果が取り込み済みか取り込み予定であり、再試行は不要。要対応欄から消す手段が
  無いことが `-1002-failed-task-abandon-flow` の題材。

## フェーズ

- 現在フェーズ: **4(思いつく改善すべて)**。フェーズ 1〜3 の遡及確認は `HR-20260830-0236` で回答済み。
- 確認の線引きは `D-20260830-0303-phase4-consent-granularity` に記録済み。
- 回答待ち(2 件。枠は 4 件までなので 2 件ぶん空いている):
  - `HR-20260830-1053-topic-conflict-prone-parallelism` — 同じファイルを取り合う並列実行を減らすか
  - `HR-20260830-1057-topic-denied-operation-audit` — 禁止した操作を試みた事実を残すか
- 今回承認されてタスク化したもの: 退避ブランチの取り込み済み判定を status に出す /
  設定ファイルが古いことを status の要対応に出す。
- 見送りになったトピック(再提案しないこと): ループの異常停止を status に残す /
  利用上限の待機をリポジトリ間で共有する / タスクに「最後に動いた時刻」を記録して status に出す /
  管理から外れた作業場所の検出 / 実行中タスクの記録を仕組みで守る /
  手元の ccloop を入れ替える専用サブコマンド / ループのプロセス番号を記録・表示する /
  1 セッションの持ち時間を再試行のたびに伸ばす。

## 確認トピックの在庫

**空**(今回掘り当てた 2 件はその場で提出した)。枠は 2 件空いている。
新しい設計判断を掘り当てるところが毎回いちばん価値のある仕事になっている。

## 突き合わせ済みで食い違いが無いことを確認した範囲

同じ調査を繰り返さないための記録。

- `lib/prompt/PROMPT.md` と実装、`README.md` / `docs/` / `lib/help.ts` と実装、初回導入の経路、
  `lib/settings.template.json` と `.agent/claude-settings.json` の合成、`.agent/config.json` の各キーと
  既定値、`CHANGELOG.md` の未リリース節と `git log`、`lib/templates/` と `docs/compatibility.md`:
  いずれも突き合わせ済みで食い違い無し(唯一の例外が下記の permission 記録)。
- 掘り終えた系統: 利用者から見た CLI の体験 / ループの運転そのものの弱点 / 初回導入の体験 /
  並列実行と状態ディレクトリ / 長時間の連続稼働 / 複数リポジトリの併用 / 費用・所要時間 /
  記録ファイルの読み書きの頑健性 / 失敗時の診断体験 / テスト自体の質 /
  探索セッションとタスクセッションの並走 / Claude Code プロセスの起動と結果の解釈 /
  セッションに渡す設定の組み立て / `ccloop status`・`watch` の表示ロジック /
  `.agent/` 雛形と実リポジトリの往復 / git 操作そのものの異常系 /
  エスカレーション・リトライ方針の実効性 / 作業場所とタスクの対応が崩れたときの回復 /
  `.agent/` の記録が人手で編集されたときの扱い / 分類の分岐が互いに排他だと仮定している箇所 /
  `ccloop watch` の表示分岐と起動時復旧の細部 / 多段処理の中断耐性。
- 失敗回数の計上(今回): `recordFailure`(`lib/supervisor.ts:1652`)の分岐、`conflictRetries` の
  永続化(タスクファイルの frontmatter。ループ再起動でリセットされない)、
  `classifyTaskSessionResult` の衝突分類、`finishTaskSession` 経由の通常経路はいずれも正しい。
  **唯一の抜けは起動時回収の衝突検知が `kind: "recovery"` をハードコードしている点**で、
  `-1053-startup-recovery-conflict-uses-retries` に切り出した。
- 未検証のまま残った枝葉(実害は薄いと判断): submodule を含むリポジトリでの worktree 作成、
  shallow clone での `merge-base`、`.gitattributes` / `core.autocrlf` の正規化が退避パッチの
  復元に与える影響、`index.lock` 残存時の挙動。

## 次にやると完了に近づくこと

1. 救出(`-1053-rescue-finish-interrupt-recovery-work`)。退避ブランチが消えると成果が失われる。
2. `HR-20260830-1053-topic-conflict-prone-parallelism` への回答。衝突の常態化を
   人力運用で抑え続けるか仕組みにするかが決まる。
3. 残りは鎖の順に消化する。

次の探索セッションへの申し送り:

- **確認トピックの在庫は空。枠は 2 件空いている。**
- **当たり続けている切り口は「リポジトリの実物を見る」。** 今回の構造的発見も
  `wc -l lib/*.ts` と `git log --oneline -- lib/supervisor.ts | wc -l` を叩いただけで出た。
  毎回の手順に「生成物・設定ファイル・ブランチ一覧・ファイルサイズとコミット頻度の実物を見る」を入れること。
- **直列化した鎖は毎回見直すこと。** 完了した輪は `dependencies` から外し、新しく
  `lib/supervisor.ts` を触るタスクを作ったら鎖の末尾に繋ぐ。張り忘れると衝突が再発する。
- `HR-20260830-1057-topic-denied-operation-audit` が未回答のまま次の探索まで残った場合は、
  共通ルール(`lib/prompt/PROMPT.md`)の記述を実態に合わせる小さな修正だけ先に行う(表示は変えない)。
- 明示的に未着手のまま残っている系統は「プロンプト注入の内容がセッションの挙動に与える影響
  (長さ・順序・重複)」だけ。機械的に検証しづらく収穫の見込みは高くない。
- 調査で `Bash(git worktree*)` とブランチ操作が権限で使えないため、作業場所まわりは実機再現が
  できない。コード読解で当たりを付け、再現は着手するタスクセッション側に委ねる形になる。
