# 互換性

## `.agent/config.json` の `schemaVersion`

`.agent/config.json` はスキーマバージョンを持つ(現在 1)。ccloop 本体のバージョンと利用側リポジトリの
`.agent/` のスキーマは別々に進む(feature を上げても利用側が `init --upgrade` するまで `.agent/` は
古いスキーマのまま)ため、両者の食い違いを検出する必要がある。

- **ツールが新しく `.agent/` のスキーマが古い場合**: `ccloop init --upgrade` を実行すると、
  既存の値を保ったまま新しいキーを補って `schemaVersion` を上げる。
- **`.agent/` のスキーマがツールより新しい場合**(古い feature バージョンを使っているコンテナで、
  新しいスキーマの `.agent/` を持つリポジトリを開いた場合など): ツールを更新する。feature の
  メジャータグ(例: `ghcr.io/koharakazuya/claude-code-loop/ccloop:1`)を固定して使うことを推奨する。
  メジャーバージョン内では `.agent/` のスキーマに互換性のない変更を入れない方針とすることで、
  同じメジャータグを指している限り `.agent/` を書き換えずに追従できるようにする。

## feature のタグ運用

`features/ccloop/devcontainer-feature.json` の `version` は `package.json` と同じ値に保ち、
`vX.Y.Z` タグの push をトリガーに GitHub Actions(`.github/workflows/release.yml`)が publish する。
リリースワークフローはタグのバージョンと feature の `version` が一致することを検証してから
publish するため、この 2 箇所がずれた状態ではリリースが失敗する(ずれを検出する安全弁であり、
手動で同期を保つ必要がある)。

利用側は `:1` のようなメジャータグで固定して参照することを推奨する。メジャーバージョンを上げるのは
`.agent/` のスキーマに互換性のない変更が入るときに限定する。

## state.json / タスク frontmatter の後方互換方針

`state.json`(実行時状態、リポジトリ外)とタスク/決定/Human Review の frontmatter
(`.agent/tasks/*.md` 等、git 管理)は、どちらも将来のフィールド追加を前提にゆるく読む
(未知のキーは無視し、欠けているキーは既定値で補う)。フィールドの削除・意味変更をする場合は
`schemaVersion` を上げて `init --upgrade` の移行対象にする。

## 既知の脆さ: レート制限検出は文言マッチ

`lib/ratelimit.ts` の `detectRateLimit` は、Claude Code セッションの stdout/stderr にレート制限を示す
文言が含まれるかどうかで判定している。Claude Code の出力文字列は安定した API 仕様ではないため、
Claude Code 側の出力文言が変わると検出が効かなくなる(バックオフが働かず通常のリトライとして
扱われる)リスクが常にある。症状としては「レート制限中のはずなのに `rateLimit.backoffMs` を待たず
即座にリトライを繰り返す」という形で現れる。心当たりがあれば `lib/ratelimit.ts` の判定文言を
実際の出力に合わせて更新する。
