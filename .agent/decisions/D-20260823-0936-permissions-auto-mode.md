---
title: "permissions テンプレートを auto モード前提に整理(allow は読み取り専用のみ、deny が実質のガードレール)"
reversibility: high
createdAt: 2026-08-23T09:36:35.000Z
---

`lib/settings.template.json` の `permissions` を、auto モードの実挙動に合わせて作り直した。
allow は読み取り専用で副作用の無い git/シェルコマンド(`git status/log/diff/show/rev-parse/ls-files/blame`、
`ls` `cat` `grep` `wc` `diff`)に限定し、deny を実質のガードレール(機密パスの読み取り・自己改変対象の
編集・危険な git 操作・`sudo`)として拡充した。`{{HOME}}` プレースホルダ置換(`renderSettingsTemplate`)
は不要と判明したため廃止し、`~/` 記法をそのまま deny に書けるようにした。

## 根拠(実機検証: Claude Code 2.1.220、`claude -p --permission-mode auto`)

- deny に一致しない操作は allow の有無に関わらずほぼ許可される。`Edit`・`Write`・`Agent`・`WebFetch` は
  allow に列挙が無くても即時に通過する。
- allow 外の書き込み系 Bash(`git add`/`git commit`/`npm run` 等)は classifier の判定を経て
  1.5〜2 秒、`git -C . push` のような境界事例では 7〜17 秒かかる(または拒否される)。
- `~/` 記法の deny(`Read(~/.claude/**)` 等)は `Read` ツールと同一パスに触れる Bash(`cat` 等)の
  両方に効く。パス系の `Edit(path)` deny だけで `Write` ツールや `cp` による同一パスへの書き込みも
  止まる。
- 複合コマンド内の `git push`(例: `a && git push`)や `git -C . push` のような迂回表現も deny に
  拒否される。
- `git stash` は deny に無いと通ってしまう(意図しない作業ツリー変更のリスクがあるため deny に追加した)。

## 見送った案

- **default / dontAsk モードへの変更**: cwd 内へのリダイレクトのような無害な操作まで境界チェックで
  引っかかり拒否・保留になるケースが多く、ターン浪費が大きいため見送った。
- **`git commit --no-verify` や絶対パス `rm -rf` 個別の deny**: deny はコマンド文字列の前方一致/完全一致
  でしか判定できず、オプションの位置をずらすだけで容易に迂回できてしまう(例: `git commit -m x --no-verify`
  は前方一致パターンで拾えない)ため、個別パターンでの deny 追加は見送った。

## 既知のギャップ

- deny はコマンド文字列に対する前方一致/完全一致でしか判定できないため、`git branch -D *` のように
  スペース位置が固定されたパターンは `git branch -f` のような別のオプションを対象にできない。
  網羅的な禁止ではなく「典型的な逸脱の防止」までしか担保しない。
- `node`/`npm` による任意コード実行そのものは deny で塞げない。permissions の役割は「うっかり・逸脱の
  防止とワークフローへの誘導」であり、セキュリティ境界は実行環境(devcontainer 等)側に置く前提。

## 影響範囲

`lib/settings.template.json`、`lib/settings.ts`(`renderSettingsTemplate` 廃止、
`selfProtectDenyEntries` を `Edit(//abs)` のみに簡略化)、`lib/settings.test.ts`、
`lib/prompt/PROMPT.md`(「Bash 実行の権限制約」節・「委譲時の定型注意」)、
`.claude/CLAUDE.md`、`docs/architecture.md`(permissions 設計の節を追加)、
`lib/supervisor.test.ts`(`denialMatchesRule` に `~/` パターン・`Edit` ツール・
`git branch -D *` のケースを追加)。
