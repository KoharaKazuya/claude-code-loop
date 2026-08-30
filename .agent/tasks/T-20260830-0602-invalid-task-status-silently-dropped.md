---
title: "status が不正なタスクファイルが集計から黙って消え、watch では痕跡も残らない"
status: ready
priority: 3
dependencies: []
retries: 1
note: "失敗のため ready に戻す(1/3)。理由: main へのマージが衝突した(.agent/decisions/index.md)(元: -)"
createdAt: 2026-08-30T06:02:18.660Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので、フェーズ 4 の個別確認は不要。

## 目的

タスクファイルの `status` が不正な値のとき、そのタスクが `ccloop status` / `ccloop watch` の
集計から完全に消える(進捗バーの分母すら縮む)問題を直す。除外自体は妥当だが、
除外した事実が人間の見る出力に残らないため、存在するはずのタスクが静かに行方不明になる。

## 現象(調査で実挙動確認済み)

`taskFromFile`(`lib/supervisor.ts:265-288` 付近)は `status` が
`ready | working | blocked | completed | failed` のいずれでもないファイルを `null` にして捨てる。
`loadTasksFrom`(同 `291-306` 付近)は警告を 1 行 `console.log` するが、これは
`formatStatus()` が返す構造化テキストの外側の副作用である。

- `T-ok`(status: ready)と `T-bad`(status: done)を置いて `collectStatusData` を呼ぶと、
  返る `tasks` は 1 件のみで進捗バーの分母も 1 になる(本来 2 件)
- `ccloop status` は毎回警告行を出すが、進捗バーやセクションと無関係な位置に出るため見落としやすい
- `ccloop watch` はさらに悪い。重複抑止用の `warnedInvalidFiles`(モジュールレベルの Set)により
  プロセス生存中に一度しか警告されず、しかも `renderFrame` が毎フレーム先頭で画面をクリアする
  (`lib/watch.ts:23,60-64` 付近)ため、その 1 行も直後の描画で消える。以後、壊れたファイルが
  ある間ずっと痕跡が残らない

## 完了条件

- 不正なタスクファイルの存在が、`formatStatus()` の構造化出力に現れる。出す場所
  (「要対応」節に含めるか専用の行を足すか)と文言は実装者が決めてよいが、
  **`watch` で画面をクリアされても残る**こと、および**どのファイルが不正かが分かる**ことを満たす。
  判断の理由は `.agent/decisions/` に短く記録する
- 不正な `status` を持つファイルを混ぜたときに、分母と出力の両方を検証する回帰テストを追加する
- 不正ファイルを処理対象から除外する現在の挙動(クラッシュ回避)自体は変えない
- typecheck / lint / test が通る
- 利用者から見た表示が変わるので `CHANGELOG.md` の「## 未リリース」節に 1 行足す

## 補足

frontmatter そのものが読めない場合(BOM / CRLF)の取りこぼしは別タスクで対処済み。
こちらは frontmatter は読めるが `status` の値が語彙外、というケースである。

## 試行履歴

### 試行 1(2026-08-30T06:15:38.207Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
