# 互換性

## `.agent/config.json` の `schemaVersion`

`.agent/config.json` はスキーマバージョンを持つ(現在 1)。ccloop 本体のバージョンと利用側リポジトリの
`.agent/` のスキーマは別々に進む(feature を上げても利用側が `init --upgrade` するまで `.agent/` は
古いスキーマのまま)ため、両者の食い違いを検出する必要がある。

- **ツールが新しく `.agent/` のスキーマが古い場合**: `ccloop init --upgrade` を実行すると、
  既存の値を保ったまま新しいキーを補って `schemaVersion` を上げる。
- **`.agent/` のスキーマがツールより新しい場合**(古い feature バージョンを使っているコンテナで、
  新しいスキーマの `.agent/` を持つリポジトリを開いた場合など): ツールを更新する(`devcontainer.json`
  の feature 参照バージョンを上げてコンテナを再ビルドする)。メジャーバージョン内では `.agent/` の
  スキーマに互換性のない変更を入れない方針とすることで、メジャータグ(例: `ccloop:0`)で固定している
  利用側は `.agent/` を書き換えずに追従できる。

## feature のタグ運用

バージョンの真実は `package.json` の `version` 1 箇所とし、`features/ccloop/devcontainer-feature.json`
の `version`、README.md と `.devcontainer/devcontainer.json` の feature 参照
(`ghcr.io/koharakazuya/claude-code-loop/ccloop:X.Y.Z`)は `scripts/sync-version.mjs` で機械的に同期する。
`npm version <patch|minor|major>` の `version` フックがこれを実行してからコミットと `vX.Y.Z` タグを
作るため、通常の手順ではこれらがずれない。

ずれを検出する安全弁として `scripts/check-version.mjs` があり、CI(`.github/workflows/ci.yml`)が
毎 push で package.json を含む 4 箇所の一致を、リリースワークフロー(`.github/workflows/release.yml`)が
タグ push 時にタグバージョンとの一致まで検証してから publish する。README の参照をタグと一致させる理由は、
devcontainers/action が publish するタグは `X` / `X.Y` / `X.Y.Z` / `latest` であり、README に
実在しないタグ(例: 0.x リリース時の `:1`)を載せてしまう事故を防ぐため。

README の例は最新リリースの厳密なバージョンを示す。利用側がメジャータグ(例: `ccloop:0`)で固定して
自動追従させることもでき、メジャーバージョンを上げるのは `.agent/` のスキーマに互換性のない変更が
入るときに限定する。

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
