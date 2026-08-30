---
title: "doctor のログイン状態検査は claude auth status --json を使い、疑わしいときは必須にしない"
reversibility: high
tasks: [T-20260830-0621-doctor-auth-check]
createdAt: 2026-08-30T07:49:00.000Z
---

## 判断内容

`ccloop doctor` のログイン状態検査は `claude auth status --json`(config の `claudeCommand` で
差し替えられたコマンドを使う)の出力だけで判定し、次のとおり倒す。

- JSON を解釈できない / `loggedIn` が真偽値でない → ✗ を出すが `required: false`(終了コードは 1 にしない)
- `loggedIn: true` → ✓
- `loggedIn: false` でも API キー等の手がかりがあれば ✓(問題として扱わない)
- `loggedIn: false` かつ手がかり無しのときだけ `required: true` の ✗
- `claude --version` が失敗しているときは、この項目自体を出さない(✗ の二重表示を避ける)

終了コードは見ず標準出力の JSON だけを信じる。未ログイン時に非ゼロで終わる可能性があるが、
その挙動は未検証のため判定材料にしない。

## 理由

`claude auth status --json` は副作用なく 1 秒未満で終わり、モデル呼び出しを伴わないことを実機で
確認した(`{"loggedIn":true,"authMethod":"claude.ai",...}` を返す)。doctor の「副作用が無く、すぐ
終わる診断だけを行う」方針に収まる。

「誤警告を出すくらいなら見ないほうがまし」を優先した。未ログイン時の出力の形は未検証なので、
想定と違う出力を受け取ったときに ✗(必須)へ倒すと、正常な環境で doctor が失敗し続ける。
判定できないことは表示するが終了コードには影響させない。

## API キー運用を未ログインと誤判定しない根拠

`claude auth status --json` は API キーを検出すると `apiKeySource` フィールドを追加する
(ダミーの `ANTHROPIC_API_KEY` を付けて実測)。ただし「OAuth 未ログイン + API キーのみ」の環境で
`loggedIn` が何を返すかは未検証(検証には実際のログアウトが必要で、環境を壊すため実施しない)。

そこで `loggedIn` の値に依存せず、次のいずれかがあれば問題として扱わないことにした。

- JSON の `apiKeySource` が空でない
- 環境変数 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` /
  `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` のいずれかが
  空でない値で設定されている(ただし真偽値として使われる後ろ 2 つは `0` / `false` を除く)

`loggedIn: false` が API キー運用で返るとしても、この手がかりで ✓ になるため誤警告にならない。

## 検討した代替案

- タスクの代替案(doctor には手を入れず、認証失敗時のメッセージを分かりやすくする):
  副作用なく確実に判定する手段が見つかったため採らなかった。
- `~/.claude/` 配下の認証ファイルを直接読む: permissions の deny 対象であり、内部形式に依存する。
- 実際にモデルを呼んで確かめる: トークンを消費し、doctor の「すぐ終わる」方針に反する。

## 影響範囲

`lib/doctor.ts`(`CommandProbe.stdout` の追加と `ProbeFn` への `timeoutMs` 追加を含む)、
`lib/doctor.test.ts`、`lib/help.ts`、`README.md`、`CHANGELOG.md`。
