---
title: "テストのブランチ汚染対策は検出 + 作成経路の fail-closed に絞る"
reversibility: high
review: HR-20260830-0928-delete-leftover-test-branch
tasks: [T-20260830-0828-tests-create-real-branches, T-20260830-0929-supervisor-implicit-repo-root]
createdAt: 2026-08-30T09:32:00.000Z
---

## 判断

テストがリポジトリ本体にブランチを作る問題に対し、このタスクでは次の 2 つだけを入れた。

1. `lib/test-global-setup.ts`(vitest の globalSetup): テストラン前後でブランチ一覧を比較し、
   増えていればテストラン全体を失敗させる。
2. `lib/hooks/worktree-create.ts`: 対象ディレクトリが未指定のとき `process.cwd()` へ
   フォールバックせずエラーで落ちる(fail-closed)。

`lib/supervisor.ts` の `repoPaths()` シングルトンに依存した破壊的操作(`parkTaskWorktree` ほか)は
このタスクでは触らず、T-20260830-0929-supervisor-implicit-repo-root として切り出した。

## 理由

- 調査(サブエージェント)の結論は「現行コードを個別実行した限り汚染は再現しない」だった。
  つまり犯人の特定はできておらず、経路 A(worktree-create の cwd フォールバック)も経路 B
  (supervisor の暗黙 root)も**状況証拠**にとどまる。特定できない以上、個別の経路を潰すより
  **どの経路であっても検出できる網**を先に張るほうが確実である。
- 経路 B の是正は呼び出し元まで波及する変更で、範囲が読み切れなかった。1 セッションで無理に
  詰めるより分割したほうが安全。検出の網が入っている以上、再発しても静かには進まない。

## 検討した代替案

- **`resolveRepoRoot()` にテスト用ガードを入れ、本体を返そうとしたら throw する。**
  一箇所で全経路を塞げるが、`lib/paths.test.ts` など本体に対して正当に `resolveRepoRoot()` を
  呼ぶテストがあり、opt-out の設計が必要になる。事後検出で同じ効果が得られるため見送った。
- **増えたブランチを一律に失敗扱いにする。** このリポジトリは自分自身で自律運用されており、
  テスト実行中にも別セッションが `agent/<taskId>` ブランチを作る。誤検知で無関係なテストランが
  落ちる。対応するタスクファイルが実在する `agent/<taskId>` を除外する基準にした
  (Supervisor の孤児ブランチ判定と同じ基準)。設計意図は docs/architecture.md に記載済み。

## CHANGELOG に載せない判断

fail-closed 化も検出の仕組みも、ccloop の利用者から見た挙動は変わらない(汚染が観測されたのは
このリポジトリ自身のテスト実行時のみで、利用者が踏んでいた不具合ではない)。運用ルールの
「内部の作り替え、テストの追加は載せない」に該当するため `CHANGELOG.md` は更新しない。

## 影響範囲

`npm test` 実行時に、リポジトリ本体のブランチが増えているとテストラン全体が失敗するようになる。
本体を汚す変更を入れた場合、テストは緑にならない。
