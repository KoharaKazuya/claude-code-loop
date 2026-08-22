---
title: "tasks/decisions/human-review の ID を連番から日時 + slug へ変更"
reversibility: medium
createdAt: 2026-08-22T15:19:03.887Z
---

`.agent/tasks/` `.agent/decisions/` `.agent/human-review/` の ID(= ファイル名)採番方式を、
「既存ファイルの最大番号 + 1」の連番から `<prefix>-<YYYYMMDD>-<HHMM>-<slug>`
(prefix ∈ {T, D, HR})へ変更した。同一 ID が既にある場合(`.agent/archive/` 内も含む)は末尾に
`-2`, `-3`… を付ける。マージ時の ID 改番ロジックは廃止し、同名 add/add は通常の実質的コンフリクトと
して人間に回す。`ccloop task add` に `--slug` オプションを追加し、未指定ならタイトルから自動生成する
(ASCII 化できなければ `task`)。

理由:

- 連番は複数 worktree で並行するセッション同士が衝突しやすく、マージ時の改番(本文中の
  `dependencies` / `tasks` / `review` 等の ID 参照も追従して書き換える必要がある)という複雑さと
  取りこぼしリスクの元だった。日時を ID に含めることで採番だけでは衝突しなくなり、改番ロジック自体を
  廃止できる。
- slug を加えることで、人間が `ls` や `git log` を見ただけで各ファイルの内容を推測できる(連番だけ
  では開くまで分からない)。
- `YYYYMMDD-HHMM` はゼロ埋めされた日時なので `ls` の辞書順がそのまま作成順になり、decisions の
  直近 10 件ローテーション(辞書順 = 時系列という前提で動く)をそのまま維持できる。

検討した代替案:

- 連番 + slug(例: `T-042-rename-agent-files`): 連番部分の並行衝突は解決しない。
- ランダムな短 ID(例: `T-a3f9c2`): 衝突は避けられるが `ls` の並びが作成順と一致せず、ローテーション
  が辞書順に依存できなくなる。内容の推測もできない。
- ID とファイル名を分離する(frontmatter に ID、ファイル名は別体系): 「ファイル名がそのまま索引」
  という単純さが失われ、実装・運用が複雑になる。

影響範囲: `lib/prompt/PROMPT.md`(採番規則・テンプレート例)、README.md、
`docs/architecture.md`(設計理由)、`lib/rotate.ts` / `lib/paths.ts` のコメント、既存の
`.agent/decisions/D-20260822-01.md` を新形式へ `git mv` で移行済み。採番・slug 生成の実装
(`lib/supervisor.ts` / `lib/triage.ts` / `lib/merge.ts`)は別セッションの担当。

未確認事項: `--slug` オプションと自動生成ロジックの実装状況・実際の挙動はこのセッションでは
未検証(担当外のため触っていない)。
