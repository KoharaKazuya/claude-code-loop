---
title: "Node バージョン要件の二重管理を機械検証する"
status: completed
priority: 3
dependencies: []
retries: 0
note: "lib/node-engines-consistency.test.ts を追加。engines.node を解析して境界バージョンを生成し checkNodeVersion と突き合わせる"
createdAt: 2026-08-30T13:46:18.783Z
---

所属フェーズ: 4(思いつく改善すべて)。テストの追加に当たるため人間の確認は不要
(`D-20260830-0303-phase4-consent-granularity` の「確認を取らない」側)。

## 背景

サポートする Node のバージョン要件が 2 箇所に独立してハードコードされている。

- `package.json` の `engines.node`: `^22.18.0 || >=24.0.0`
- `lib/doctor.ts:76-86` の `checkNodeVersion`: `major >= 24` / `major === 22 && minor >= 18` という
  数値ロジックと、案内文言中の `Node ^22.18.0 || >=24.0.0` という文字列

`checkNodeVersion` は `engines.node` を参照しておらず、両者を突き合わせる自動テストも無い
(`lib/doctor.test.ts` は文言に `22.18` が含まれることしか見ていない)。現時点で値は一致しているが、
将来 `engines.node` の下限を変えたときに `checkNodeVersion` の追随を忘れると、`package.json` 上は
対応外のバージョンで doctor が「問題なし」と誤判定する(またはその逆)。

このリポジトリには同種の二重管理を機械検証する前例が既にある
(`lib/deny-consistency.test.ts` が `lib/settings.template.json` と `lib/prompt/PROMPT.md` の
deny 一覧の一致を検証、`scripts/check-version.mjs` がバージョン参照の一致を検証)。
同じやり方に揃える。

## やること

1. `package.json` の `engines.node` と `checkNodeVersion` の判定が食い違ったら落ちるテストを追加する。
   置き場所は `lib/doctor.test.ts` か新規の consistency テストのどちらでもよく、
   `lib/deny-consistency.test.ts` の書き方に倣うこと。
2. 検証の内容は最低限、次の 2 点を満たすこと。
   - `engines.node` が許容する境界のバージョン(例: 下限ちょうど、下限の 1 つ下)について
     `checkNodeVersion` の可否が一致すること。
   - 案内文言に埋め込まれた要件文字列が `engines.node` と一致すること(文言を手で書き換え忘れると
     利用者に嘘の案内が出るため)。
3. semver 解決のために新しい依存パッケージを追加しないこと。`engines.node` の書式は
   `^X.Y.Z || >=A.0.0` の形に限られているので、必要なら最小限の解析をテスト側に書く。
   将来この書式から外れたら落ちるように、解析できない書式は明示的に失敗させること。

## 完了条件

- `engines.node` か `checkNodeVersion` の片方だけを変更するとテストが落ちること
  (実装中に手元で一方を書き換えて赤くなることを確認し、結果を試行履歴に書く)。
- `npm test` / lint / typecheck が通ること。

## 注意

- 利用者から見た挙動は変わらないので `CHANGELOG.md` には追記しない。
- 現在のバージョン要件そのものを変更しないこと。このタスクは食い違いの検出だけを足す。
- 触るのはテストファイルのみを基本とする。`lib/doctor.ts` 側を `engines.node` 読み取りに
  作り替える案は、実行時に `package.json` の位置解決が必要になり配布形態の前提が増えるため
  **採らないこと**。採りたくなった場合は理由を `.agent/decisions/` に記録し、
  人間の確認(BLOCK)を経てから行う。

## 試行履歴

### 試行 1(2026-08-30T13:55:59.535Z, セッション記録)
- 確認済みの事実: `lib/node-engines-consistency.test.ts` を新規追加(既存ファイルは無変更、依存追加なし)。
  `engines.node` を `^(\d+)\.(\d+)\.(\d+) \|\| >=(\d+)\.0\.0` の厳格な正規表現で解析し、解析結果から
  境界バージョンを生成(現行値では `22.18.0` / `22.17.0` / `22.19.0` / `21.999.0` / `24.0.0` / `23.0.0` /
  `25.0.0`)して `satisfies()` と `checkNodeVersion()` の可否一致を検証する。案内文言に `engines.node` の
  値がそのまま含まれることも検証する。
- 確認済みの事実(完了条件の赤確認): (a) `engines.node` を `^22.19.0 || >=24.0.0` に一時変更すると
  `22.18.0` の判定不一致と文言不一致の 2 件が失敗。(b) `checkNodeVersion` の `minor >= 18` を
  `minor >= 19` に一時変更すると `22.18.0` の判定不一致 1 件が失敗。いずれも復元後 `git diff` は空。
  さらに (c) `engines.node` を `>=22.18.0` 単独(想定外書式)にすると `parseEngines` が null を返し、
  `it.each` が 0 件になる前に解析成功を確かめるテストが失敗することをレビュー側が別コピーで実測確認。
- 確認済みの事実(検証): `npm run typecheck` / `npm run lint` / `npm test`(35 files / 1228 tests)すべて成功。
- 次の試行への提案: なし(完了)。
