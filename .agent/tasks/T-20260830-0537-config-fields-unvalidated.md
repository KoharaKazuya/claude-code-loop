---
title: "config.json のほとんどの項目が検証されず、壊れていると素の TypeError で落ちる"
status: completed
priority: 4
note: "validateConfig を新設し、不正な項目を列挙して止めるようにした。未捕捉例外の経路は別タスクへ切り出し"
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

### 試行 1(2026-08-30T05:58:51.146Z, セッション記録)

- 確認済みの事実:
  - `validateConfig` を新設し `normalizeConfig` から呼んで throw する形で実装した(コミット 731ba4c)。
    `npm run typecheck` / `npm run lint` / `npm test`(991 テスト)すべて通過。
  - やること 2 の調査結果: `spawn` の同期 TypeError は Promise executor 内の throw なので
    `runClaude` の返す Promise の reject になる。経路により扱いが違う。
    - タスクセッション経路は `launchTaskSession`(`lib/supervisor.ts` 3195 行付近)が
      `started.result.then(onFulfilled, onRejected)` で reject を受け、`crashResultFromError` で
      「クラッシュ扱いの結果」に変換する。プロセスは落ちない。
    - 探索セッション経路(`runExploreSession` 2791 行の `try`)と triage 経路(4181 行付近)は
      `try { ... } finally { ... }` で catch を持たない。`mainLoop` のループを包む try にも catch が無く、
      `lib/cli.ts:175` の `case "run"` にもトップレベル(202 行)にも catch が無い。
      よってこの 2 経路の reject は未捕捉例外となり `ccloop run` プロセスごと落ちる。
  - 上記のうち「catch が無いこと」はコードを読んで確認した(実際に spawn を失敗させる再現実験は
    していない)。今回の検証追加により `claudeCommand` が undefined のまま起動する経路は塞がったため、
    この未捕捉経路を塞ぐ変更は入れていない。
- 未検証の推測: 探索/triage 経路の未捕捉 reject は、`claudeCommand` 以外の理由(claude 実行ファイルが
  途中で消える等)でも起こりうる。汎用の防御として `runClaude` の呼び出しを catch する価値はありそうだが、
  実害の確認はしていない。
- 次の試行への提案: 上記の未捕捉経路を塞ぐなら、タスクセッション経路と同じく
  `crashResultFromError` へ寄せるのが一貫する。別タスクとして扱うのが妥当。
