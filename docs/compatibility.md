# 互換性

## `.agent/config.json` の `schemaVersion`

`.agent/config.json` はスキーマバージョンを持つ(現在 2)。ccloop 本体のバージョンと利用側リポジトリの
`.agent/` のスキーマは別々に進む(feature を上げても利用側が `init --upgrade` するまで `.agent/` は
古いスキーマのまま)ため、両者の食い違いを検出する必要がある。

- **ツールが新しく `.agent/` のスキーマが古い場合**: `ccloop init --upgrade` を実行すると、
  既存の値を保ったまま新しいキーを補って `schemaVersion` を上げる。
- **`.agent/` のスキーマがツールより新しい場合**(古い feature バージョンを使っているコンテナで、
  新しいスキーマの `.agent/` を持つリポジトリを開いた場合など): ツールを更新する(`devcontainer.json`
  の feature 参照バージョンを上げてコンテナを再ビルドする)。メジャーバージョン内では `.agent/` の
  スキーマに互換性のない変更を入れない方針とすることで、メジャータグ(例: `ccloop:0`)で固定している
  利用側は `.agent/` を書き換えずに追従できる。

`lib/config.ts` の `validateConfig` は大半のキーを必須として検査し、欠けていれば例外を投げて止める
(誤った設定のまま気付かず走り続けるのを避けるため)。ただし新しいスキーマ版数で追加したキーの
うち、追加した時点で `init --upgrade` していない既存の `.agent/config.json`(1 つ古い版数のまま)
が読めなくなると困るものは、`triage` / `parallel` と同様に検査対象から外し、欠損・型違いは
`normalizeConfig` が既定値で寛容に埋める。`maxConflictRetries` はこの理由で必須にしていない。

## feature のタグ運用

バージョンの真実は `package.json` の `version` 1 箇所とし、`features/ccloop/devcontainer-feature.json`
の `version` と README.md の feature 参照(`ghcr.io/koharakazuya/claude-code-loop/ccloop:X.Y.Z`)は
`scripts/sync-version.mjs` で機械的に同期する。`npm version <patch|minor|major>` の `version` フックが
これを実行してからコミットと `vX.Y.Z` タグを作るため、通常の手順ではこれらがずれない。

`.devcontainer/devcontainer.json` の feature 参照と `.devcontainer/devcontainer-lock.json` はこの同期の
対象外で、リリース後に手動で更新する。lock の digest は publish 後にしか確定しないため、
devcontainer.json だけを自動更新すると lock との整合が取れない差分が生じる。lock はコンテナ再ビルド時に
devcontainer CLI が解決し直す。

ずれを検出する安全弁として `scripts/check-version.mjs` があり、CI(`.github/workflows/ci.yml`)が
毎 push で package.json を含む 3 箇所の一致を、リリースワークフロー(`.github/workflows/release.yml`)が
タグ push 時にタグバージョンとの一致まで検証してから publish する。README の参照をタグと一致させる理由は、
devcontainers/action が publish するタグは `X` / `X.Y` / `X.Y.Z` / `latest` であり、README に
実在しないタグ(例: 0.x リリース時の `:1`)を載せてしまう事故を防ぐため。

README の例は最新リリースの厳密なバージョンを示す。利用側がメジャータグ(例: `ccloop:0`)で固定して
自動追従させることもでき、メジャーバージョンを上げるのは `.agent/` のスキーマに互換性のない変更が
入るときに限定する。

## `.agent/` 記録ファイルの ID 形式の互換方針

`.agent/tasks/` `.agent/decisions/` `.agent/human-review/` の ID(= ファイル名)は連番と
日時 + slug(`<prefix>-<YYYYMMDD>-<HHMM>-<slug>`)の 2 形式が混在しうる。両形式とも読み続けられ、
新規作成されるファイルは常に新形式になる。形式の混在自体はスキーマの変更ではないため
`schemaVersion` は上げない。

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

## 異常終了は終了コードだけでは判定できない

Claude Code CLI は、セッションがターン数上限(`--max-turns`)に達して打ち切られた場合でも
**終了コード 0** で終わる。異常であることは結果 JSON 側にしか現れない
(`is_error: true` / `subtype: "error_max_turns"` / `terminal_reason: "max_turns"`)。
そのため ccloop は終了コードと結果 JSON の両方を見てセッションの成否を分類する。

同じ構造は他の終了理由(`error_during_execution` など)にも当てはまるため、
`is_error: true` は既定で失敗として扱う。ただしレート制限による終了も `is_error: true` を
出すため、この判定はレート制限判定より後ろに置く必要がある。判定順序を入れ替えると、
待てば解決するレート制限がタスクの失敗として数えられ、`retries` を食い潰す。
