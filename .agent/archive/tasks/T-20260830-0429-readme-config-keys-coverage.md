---
title: "README の設定キー一覧に説明の抜けている項目を足す"
status: completed
priority: 4
dependencies: []
retries: 0
note: "claudeCommand / idlePollMs / parallel.worktreeDir / parallel.linkPaths の 4 行を追加。既存行のずれは無し"
createdAt: 2026-08-30T04:29:08.819Z
---

所属フェーズ: 4(思いつく改善すべて)。ドキュメントを実装へ追従させるだけのため個別確認は取っていない。

## 目的

`.agent/config.json` で設定できる項目のうち、README の一覧に載っていないものを補う。

## 現状

README の設定表(`README.md:137-148` 付近)は `schemaVersion` / `model`・`escalation` /
`permissionMode` / `maxRetries`・`taskTimeoutMs`・`maxTurns` / `rateLimit.backoffMs` /
`explore` / `triage` / `parallel.maxSessions` を載せている。

一方 `Config`(`lib/config.ts:13-45`)には `claudeCommand` / `idlePollMs` /
`parallel.worktreeDir` / `parallel.linkPaths` も存在し、実際に読まれて挙動に影響する
(`claudeCommand` は `lib/doctor.ts:150-152` の診断対象にもなっている)。

Claude Code をラッパー経由で呼びたい・worktree の置き場を変えたい利用者は、README からは
これらの存在を知り得ない。

## 完了条件

- 上記 4 項目を README の設定表に追加する。既定値と、変えると何がどうなるかを 1 行で書く。
- 追加のついでに、表の既存行が現在の実装(既定値・意味)と一致しているかも確認し、
  ずれていれば直す。値の根拠は `lib/config.ts` と `lib/migrations.ts`。
- 実装の変更は伴わない。docs/ 運用ルール(過去の経緯を書かない・量を増やしすぎない)に従う。
- `CHANGELOG.md` には載せない(ドキュメントの記述改善のため)。
