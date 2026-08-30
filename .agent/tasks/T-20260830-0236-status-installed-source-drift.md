---
title: "status にインストール済み ccloop とリポジトリの乖離を表示する"
status: completed
priority: 2
dependencies: []
retries: 0
note: "status に乖離警告を追加。実機で表示を確認済み(tests/lint/typecheck 通過)"
createdAt: 2026-08-30T02:36:30.702Z
---

所属フェーズ: 現在フェーズ内の修理作業(人間向け表示が実態と食い違っている状態の解消)。新機能の追加ではない。

## 目的

このリポジトリは公開版 ccloop feature を DevContainer に入れて自己ホストしており、`ccloop` コマンドの
実体は `/usr/local/share/ccloop/lib/` にある。リポジトリの `lib/` を書き換えても、再インストール
するまで人間が実行する `ccloop status` の挙動は変わらない。

この乖離が現在、人間の導線を実際に壊している。2026-08-30 時点で `.agent/decisions/index.md` には
未承認の決定が 7 件あり、それを表示する機能(`loadPendingDecisions` /
`pendingDecisionsSectionLines`、`lib/supervisor.ts`)は実装・マージ済みであるにもかかわらず、
`ccloop status` は「要対応事項なし」と表示する。インストール済みのコピー(2026-08-29 導入)に
その実装が含まれていないためだが、人間からは「機能が壊れている」ようにしか見えない。

既存の陳腐化警告 `isSupervisorSourceStale`(`lib/supervisor.ts:2189`)は、`ccloop run` 起動時に
記録したハッシュと **インストール先** の現在のハッシュを比較するもので、リポジトリの `lib/` との
乖離は検出しない。

## 完了条件

- `ccloop status` が、自己ホスト状態(= カレントリポジトリが ccloop 自身のソースを持つ)を検出したとき、
  インストール済みのソースとリポジトリの `lib/` が乖離している旨と、反映するための手順を表示する。
  - 自己ホストの判定方法は実装者が決めてよい(リポジトリ直下の `package.json` の `name` が
    ccloop であり、かつ `lib/supervisor.ts` が存在する、など)。判定できない環境では
    何も表示しない(通常の利用側リポジトリで誤警告を出さないこと)。
  - 表示は「稼働状態」節の陳腐化警告と並べるのが自然。既存の警告文と混同しない文言にする。
- 反映手順(feature の再インストール、または再ビルドの方法)がドキュメントから追える状態にする。
  手順が docs/ に無ければ、docs/ 運用ルール(`.claude/CLAUDE.md`)に従って適切な箇所へ追記する。
- 追加した判定ロジックに単体テストを付ける(純粋関数として切り出し、fs 依存は引数で渡す形が望ましい)。
- `npm run` で利用可能な検証(tests / lint / typecheck)を通す。

## 補足

「インストール済みが古い」ことを検出できない環境(feature 経由ではなくソースから直接起動している等)
では警告を出さない方に倒すこと。誤警告は導線のノイズになり、この作業の目的と逆行する。
