---
updatedAt: 2026-08-30T09:34:06.873Z
completed: 58
total: 70
---

# OVERVIEW(GOAL に対する現在地)

GOAL の「現在の目標」は 2 つとも、当初挙がっていた作業を消化し終えている。

1. decisions アーカイブの人間承認化と `ccloop status` への未承認決定の表示 — 完了。
2. 人間の確認・介入の導線を磨く — 変更履歴、手元の ccloop を入れ替える手順の文書化、
   `ccloop status` の文脈表示、ループの生存表示、`ccloop retry` までが完了。

以後の前進は、**フェーズ 4 の確認トピックを人間に投げて枠を回し続けること**と、
**確認不要で拾える修理を掘り当てること**の両輪で決まる。

## 今いちばんの懸念: 次にループを起動すると始まらない

このリポジトリの `.agent/config.json` は版番号 1 のままだが、直近の変更で本体が求める版が
2 に上がった(衝突リトライの別枠化に伴う設定項目の追加)。この食い違いがあると `ccloop run` は
起動を拒否する(`status` などは動く)。走行中のループは変更前に起動しているので動き続けるが、
**次の起動で止まる。**

設定ファイルの書き換えは deny リストで禁じられているため、セッション側では直せない。
`HR-20260830-0934-config-upgrade-needed`(BLOCK)で `ccloop init --upgrade` の実行を依頼した。
**人間の操作待ちの中でこれが最優先である。**

## 2 つ目の懸念: 成果の取り残しが 3 例目

`T-20260830-0808-conflict-session-timeout-mislabeled` が 3 回とも衝突で失敗して `failed` になり、
完成した実装(失敗理由の判定順を「衝突 → 時間切れ」に直す修正 + テスト 147 行 + 判断記録)が
退避ブランチ `agent/conflict/T-20260830-0808-...-20260830T092322Z` に取り残された。
救出タスク `T-20260830-0934-rescue-failure-kind-priority-work`(p1)を登録済み。

**ただし今回は原因を確定できた。** 3 回の失敗はいずれも「衝突リトライを本来の retries と
別枠にする」修正が main に入る(2026-08-30T09:24:29Z)**前**に起きており、新機構の不備ではなく
旧動作そのものである。別枠化が効いている以上、同じ経路での 4 例目は起きにくい。
残る構造的な穴は「退避ブランチの成果を誰かが気づいて救出タスクを作る」という属人的な運用に
依存している点で、これは `HR-20260830-0934-topic-parked-branch-merged-state` で表示改善を確認中。

## いま動いているもの

- 実行中(他セッション): `T-20260830-0828-tests-create-real-branches` /
  `T-20260830-0825-metrics-read-cap` / `T-20260830-0829-finish-crash-leaves-no-trace`
- 着手待ち(priority 順):
  - `T-20260830-0934-rescue-failure-kind-priority-work`(p1)— 上記の救出。最優先。
    統合時に `recordFailure` のシグネチャ変更とぶつかるので単純マージでは通らない。
  - `T-20260830-0810-decisions-index-missing-entries`(p3)— 決定の一覧に載らない記録がある。
  - `T-20260830-0903-merge-abort-retry-racy-git`(p3)— 同一秒内の連続 git 操作で巻き戻しが失敗する。
  - `T-20260830-0934-startup-recovery-crash-leaves-no-trace`(p3)— 起動時復旧にも
    `-finish-crash-leaves-no-trace` と同型の中断窓がある。実行中タスクが巻き取っている
    可能性があるので着手時に main を確認すること。
  - `T-20260830-0825-dependency-cycle-detection`(p4)— 依存の輪の検出。同意済み(優先度低)。
  - `T-20260830-0808-human-task-edit-lost-on-merge`(p4)— 依存していた救出タスクは完了済みで、
    もう待たされていない。
  - `T-20260830-0825-archived-tasks-read-cap`(p5)— 書庫の読み込みを軽くする。同意済みだが
    回答で「優先度は低い」と明示された。

人間の手が要る残務(ブランチ削除はセッションの権限外)。

- 削除してよい(内容は main へ取り込み済み):
  - `agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z`
  - `agent/conflict/T-20260830-0621-conflict-retry-always-reconflicts-20260830T082329Z`
- **まだ削除してはいけない**(唯一の成果の置き場):
  - `agent/conflict/T-20260830-0808-conflict-session-timeout-mislabeled-20260830T092322Z`
- テストが本体リポジトリに残した `T-001` ブランチ(`T-20260830-0828-tests-create-real-branches` が
  原因側を修理中。残骸そのものの削除は人間の操作)。

## フェーズ

- 現在フェーズ: **4(思いつく改善すべて)**。フェーズ 1〜3 の遡及確認とフェーズ 4 の運用可否は
  `HR-20260830-0236-phase-gate-applicability` で回答済み・closed。
- 確認の線引きは `D-20260830-0303-phase4-consent-granularity` に記録済み。
- 回答待ち(3 件。枠は 4 件までなので 1 件ぶん空いている):
  - `HR-20260830-0934-config-upgrade-needed` — 設定ファイルの更新依頼(トピック確認ではなく操作依頼)
  - `HR-20260830-0934-topic-schema-version-in-status` — 設定ファイルの古さを status に出すか
  - `HR-20260830-0934-topic-parked-branch-merged-state` — 退避ブランチの取り込み済み判定を出すか
- 見送りになったトピック(再提案しないこと):
  - ループの異常停止を status に残す(`D-20260830-0825-fatal-stop-record-declined`)
  - 利用上限の待機をリポジトリ間で共有する(`D-20260830-0825-cross-repo-ratelimit-declined`)
  - タスクに「最後に動いた時刻」を記録して status に出す(`D-20260830-0429-task-last-updated-declined`)
  - 管理から外れた作業場所の検出(`D-20260830-0934-orphaned-worktree-detection-declined`)
  - 実行中タスクの記録を仕組みで守る(`D-20260830-0934-running-task-file-guard-declined`)
  - 手元の ccloop を入れ替える専用サブコマンド → 文書化のみと決着
  - ループのプロセス番号を記録・表示する / 停止の導線を増やす
    (`D-20260830-0621-foreground-run-is-the-supported-usage`)
  - 1 セッションの持ち時間を再試行のたびに伸ばす

## 確認トピックの在庫

枠が空いたときに HR へ出す候補。**在庫は空である**(今回掘り当てた 2 件はその場で提出した)。
次の探索は新しい在庫を掘るところから始まる。

## 突き合わせ済みで食い違いが無いことを確認した範囲

同じ調査を繰り返さないための記録。

- `lib/prompt/PROMPT.md` と実装、`README.md` / `docs/` / `lib/help.ts` と実装、初回導入の経路:
  いずれも突き合わせ済みで食い違い無し。
- 掘り終えた系統: 利用者から見た CLI の体験 / ループの運転そのものの弱点 / 初回導入の体験 /
  並列実行と状態ディレクトリ / 長時間の連続稼働 / 複数リポジトリの併用 / 費用・所要時間 /
  記録ファイルの読み書きの頑健性 / 失敗時の診断体験 / テスト自体の質 /
  探索セッションとタスクセッションの並走 / Claude Code プロセスの起動と結果の解釈 /
  セッションに渡す設定の組み立て / `ccloop status`・`watch` の表示ロジック /
  `.agent/` 雛形と実リポジトリの往復 / git 操作そのものの異常系 /
  エスカレーション・リトライ方針の実効性 / 作業場所とタスクの対応が崩れたときの回復 /
  `.agent/` の記録が人手で編集されたときの扱い / 分類の分岐が互いに排他だと仮定している箇所 /
  `ccloop watch` の表示分岐と起動時復旧の細部。
- git 操作の異常系: 問題無しと確認済み —— `lib/merge.ts` の自動マージ(進行中の git 操作を
  横取りしない事前ガード、`merge --abort` 失敗時の分離、racy git 対策)、
  `gitOperationInProgress` / `mergeInProgress` が linked worktree を吸収すること、
  `removeWorktree` の削除失敗時フォールバック、`commitAgentDir` の二段階チェック、
  起動時復旧が `MERGE_HEAD` の SHA 突合で人間のマージに触れないこと。
  未検証のまま残った枝葉(実害は薄いと判断): submodule を含むリポジトリでの worktree 作成、
  shallow clone での `merge-base`、`.gitattributes` / `core.autocrlf` の正規化が退避パッチの
  復元に与える影響、`index.lock` 残存時の挙動。
- エスカレーション・リトライ方針: 問題無しと確認済み —— 利用上限の待機と crash-backoff の
  優先順位、crash-backoff のストリーク管理、通常経路の利用上限が `retries` を消費しないこと、
  モデル昇格の条件、依存タスクが `failed`/`blocked` になったときの連鎖が数周で収束すること、
  衝突解消セッションが上限に達したときの worktree 削除とブランチ退避、
  セッション終了直後のクラッシュで `retries` が失われる経路が無いこと、
  スヌーズと再試行が構造的に競合しないこと。
- 作業場所とタスクの対応: 問題無しと確認済み —— 孤児ブランチの回収は実ブランチ一覧だけを
  真実として駆動しており `state.json` が壊れても不整合を招かない、`state.json` の実行中記録は
  起動のたびに無条件でクリアされる、衝突解消待ちの作業場所の再利用は冪等、マージ失敗
  (`blocked`/`wedged`)時は作業場所・ブランチ・タスクファイルに触れず先送りする、
  タスクファイルが消えてブランチだけ残ってもクラッシュせず警告に落ちる。
- 記録の人手編集: 問題無しと確認済み —— `lib/frontmatter.ts` はどんな壊れ方でも例外を投げず
  フォールバックする、不正な `status` は既に「要対応」へ出している
  (`D-20260830-0614-invalid-task-files-in-action-section`)、`tasks/` と `archive/tasks/` に
  同 ID があっても現役側が優先される、`rotate.ts` は archive の同名ファイルを上書きせず報告する、
  decisions の index は実体とのずれを自動修復する、Human Review のチェックボックスを人間が
  どう崩しても意図が無視される経路は無い、`commitAgentDir` は `.agent/` 以外の人間の作業を保護する。
- 排他仮定の分岐: 問題無しと確認済み —— `lib/scheduler.ts` の `planLoopStep` の優先順位は
  コメントと実装が一致、`lib/triage.ts` の両方チェックは明示的に Stage 2/3 へ回る、
  `lib/merge.ts` の分類は想定外のパスが 1 つでも混ざれば安全側に倒れる、`lib/liveness.ts` は
  「疑わしきは拒否」で一貫、`mergeStuck` と `wedged`/`conflict`/`blocked` は構造的に排他、
  `collectPendingConflicts` は衝突中の作業場所と退避ブランチを両方表示する。
- `watch` と起動時復旧: 問題無しと確認済み —— `lib/watch.ts` は `formatStatus()` を
  呼ぶだけの薄いポーリングループで独自の状態分類を持たず、例外は 1 フレーム分の失敗に留まる。
  `lib/liveness.ts` の `running`/`stopped`/`unknown` の判別は網羅的。「実行中」と
  「次に実行予定」の二重表示は明示的に除外済み。`recoverOrphanBranch` の各分岐は
  取りこぼしなく分類されている。作業場所だけ消えてブランチが残った状態は `nothing-to-merge`
  判定で自己修復される。**抜けは中断窓だけで、`-finish-crash-leaves-no-trace` と
  `-startup-recovery-crash-leaves-no-trace` の 2 タスクに切り出した。**
- **多段処理の中断耐性(今回)**: 問題無しと確認済み —— `lib/rotate.ts` は「移動してから index を
  書く」順序がコメントで明示され再実行に対して冪等、`scripts/release.mjs` 系は中断時にどこまで
  進んだかを利用者へ明示する、`commitAgentDir` は失敗時に `git reset` で戻し再試行が冪等、
  `lib/worktree.ts` は途中まで書けた退避パッチを明示的に削除する。

## 次にやると完了に近づくこと

1. 人間が `ccloop init --upgrade` を実行する(`HR-20260830-0934-config-upgrade-needed`)。
   これが済むまで次のループ起動ができない。
2. 救出(`-rescue-failure-kind-priority-work`)。退避ブランチが消えると成果が失われる。
3. 残りは priority 順に消化する。

次の探索セッションへの申し送り:

- **確認トピックの在庫は空。** 枠は 1 件空いている。新しい設計判断を掘り当てるところが
  毎回いちばん価値のある仕事になっている。
- **今回も当たったのは「リポジトリの実物を見る」切り口。** 版番号の食い違いは
  `.agent/config.json` と `lib/migrations.ts` の数字を突き合わせただけで見つかった。
  退避ブランチが 3 本あって 2 本は取り込み済み、というのも `git branch` を眺めて分かった。
  **毎回の手順に「生成物・設定ファイル・ブランチ一覧の実物を見る」を入れること。**
- 「多段処理の中断窓」の切り口は今回でほぼ掘り尽くした(残りは上記の確認済み一覧を参照)。
- 明示的に未着手のまま残っている系統は「プロンプト注入の内容がセッションの挙動に与える影響
  (長さ・順序・重複)」だけ。機械的に検証しづらく収穫の見込みは高くない。
- 調査で `Bash(git worktree*)` とブランチ操作が権限で使えないため、作業場所まわりは実機再現が
  できない。コード読解で当たりを付け、再現は着手するタスクセッション側に委ねる形になる。
