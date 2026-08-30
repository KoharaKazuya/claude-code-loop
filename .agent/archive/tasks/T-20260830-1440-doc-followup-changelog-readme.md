---
title: "直近の変更のドキュメント追随漏れ 2 件を埋める"
status: completed
priority: 3
dependencies: []
conflicts: [T-20260830-1407-narrow-readonly-git-deny-patterns]
retries: 0
createdAt: 2026-08-30T14:40:12.229Z
note: "CHANGELOG 未リリース節に status の待ち理由表示の修正を追記し、README の retry 説明に conflictRetries を追記した。lint/typecheck/test 通過"
---

所属フェーズ: 4(思いつく改善すべて)。どちらも「入れた変更に対する記載漏れの解消」であり、
`D-20260830-0303-phase4-consent-granularity` の線引きに従い事前の確認(Human Review)は不要な範囲。

## 目的

直近に入った 2 つの変更について、ドキュメント側の追随が漏れている。どちらも 1〜2 行の追記で済むが、
放置すると README / 変更履歴が実装と食い違ったまま公開される。

## 直すもの(1)CHANGELOG の未リリース節に修正 1 件が載っていない

`ecee4f4 fix(status): 次に実行予定が空のとき競合待ちとスヌーズ待ちを両方表示する` は
利用者から見た表示の不具合修正だが、`CHANGELOG.md` に行が足されていない。

確認済みの事実:

- `git show --stat --format= ecee4f4` の変更ファイルは `lib/supervisor.ts` とタスクファイルのみで
  `CHANGELOG.md` を含まない。
- `grep -n "スヌーズ" CHANGELOG.md` は 0 ヒット。
- 同種の表示不具合(`80cb12e` 競合待ち件数の頭打ち)は未リリース節の `### 修正`(`CHANGELOG.md:163`
  付近)に 1 行載っており、こちらだけが漏れている。
- 修正前は三項演算子で待ち理由を 1 つしか出しておらず、競合待ちがあるとスヌーズ待ちが隠れていた。
  利用者から見て「スヌーズ中のタスクがあるのに表示されない」という挙動だったため、載せる粒度に当たる。

やること: `CHANGELOG.md` の「## 未リリース」→「### 修正」に、利用者の言葉で 1 行足す。
内部の関数名・ファイルパス・コミットハッシュは書かない。

## 直すもの(2)README の `ccloop retry` の説明が conflictRetries に触れていない

`README.md:117-119` の「failed / blocked タスクの再実行」は `status: ready`、`retries: 0` に戻すと
だけ書いているが、実装は `conflictRetries` も 0 に戻している。

確認済みの事実:

- `lib/supervisor.ts:4992` が `task.conflictRetries = 0` を実行し、`lib/supervisor.ts:5000` の完了
  メッセージも `status: ready / retries: 0 / conflictRetries: 0` と両方を出している。
- `lib/help.ts:110` は「retries と conflictRetries を 0 にする」と正しく両方書いている。
- `grep -n "conflictRetries" README.md` は 0 ヒット(README だけが古い)。

やること: README の当該箇所に `conflictRetries` も 0 に戻ることを追記する。README は利用者向けなので、
フィールド名を出すなら「マージ衝突による再試行回数」のような説明を添える(周辺の書きぶりに合わせる)。
これは README の記述修正であり、利用者から見た挙動は変わらないため CHANGELOG には載せない。

## 完了条件

- 上記 2 箇所が直っている。
- `npm run lint` / `npm run typecheck` / `npm test` が通る(ドキュメントのみの変更でも実行して確認する)。
- (1)の CHANGELOG 追記が「## 未リリース」節の中に入っており、バージョン見出しを手で作っていない。
