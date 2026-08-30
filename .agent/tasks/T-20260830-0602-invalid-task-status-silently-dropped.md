---
title: "status が不正なタスクファイルが集計から黙って消え、watch では痕跡も残らない"
status: completed
priority: 3
dependencies: []
retries: 0
note: "不正な status のファイルを StatusData.invalidTaskFiles に載せ、要対応節に表示するようにした"
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
