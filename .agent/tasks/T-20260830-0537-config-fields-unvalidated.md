---
title: "config.json のほとんどの項目が検証されず、壊れていると素の TypeError で落ちる"
status: ready
priority: 4
retries: 0
createdAt: 2026-08-30T05:37:00.000Z
---

所属フェーズ: 4(思いつく改善すべて)。診断性の修理であり、人間への確認は取らずに進めてよい。

## 何が起きているか

`normalizeConfig`(`lib/config.ts`)の docstring(59-62 行)は「欠損・不正値は既定値で埋める」と
広く主張しているが、実装(90-95 行)は `escalation` / `parallel.*` / `triage` だけを組み立て直し、
残りは生の JSON を `{ ...(r as unknown as Config) }` でそのままキャストして流している。

検証も補完もされないのは `claudeCommand` / `model` / `permissionMode` / `maxRetries` /
`taskTimeoutMs` / `maxTurns` / `rateLimit` / `explore` / `idlePollMs`。
`lib/migrations.ts` の欠損キー補完(`V1_DEFAULTS`)は `schemaVersion` の 0→1 の移行時にしか
働かないため、既に `schemaVersion: 1` のファイルから後からキーが消えた場合は誰も埋めない。

実行して確認済み:

```
$ npx tsx -e 'import { normalizeConfig } from "./lib/config.ts"; console.log(JSON.stringify(normalizeConfig({}, "/tmp/fakeroot")))'
→ claudeCommand: undefined, maxTurns: undefined, taskTimeoutMs: undefined, ...
$ node -e 'require("child_process").spawn(undefined, ["--version"])'
→ TypeError: The "file" argument must be of type string. Received undefined
```

`claudeCommand` が undefined だと `runClaude`(`lib/supervisor.ts:1791`)の `spawn` が同期的に
`TypeError` を投げる。

## 実害

`.agent/config.json` は人間が手で編集する前提のファイルである。1 つキーを消す・型を間違えると、
「どの項目がおかしいか」を一切示さない素の `TypeError`(あるいは無言の異常動作)になる。
壊れた設定は既定値へ倒さず明示的に止めるのがこのリポジトリの方針なので、**止めること自体は
正しい。止まり方が診断の役に立たないことが問題**である。

発生条件は「移行済みの config を手編集で壊す」場合に限られるため優先度は低い。

## やること

1. `normalizeConfig` の未検証フィールドについて、型と必須性を検査する。方針は既存の
   「壊れた設定は既定値へ倒さず明示的に止める」に合わせ、どの項目がどうおかしいかを
   人間の言葉で示して止めること(黙って既定値で埋める方向にはしない)。
   docstring の「欠損・不正値は既定値で埋める」という記述は、実装が実際にやることに
   合わせて書き直す。
2. `TypeError` が `runClaude` の Promise executor の中で投げられた場合に、
   `ccloop run` プロセス全体が落ちるのか 1 セッションの失敗として吸収されるのかは未検証。
   1 の検査を入れれば起動前に止まるが、念のためこの経路も確認し、分かったことを
   タスクの `## 試行履歴` に書き残すこと。
3. `lib/config.test.ts` にテストを足す。
4. 内部の作り替えではなく利用者が踏む不具合の修正なので、`CHANGELOG.md` の
   「## 未リリース」に 1 行足す。

## 試行履歴
