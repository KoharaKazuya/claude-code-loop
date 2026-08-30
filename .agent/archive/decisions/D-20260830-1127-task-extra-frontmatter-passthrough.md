---
title: "タスクの未知 frontmatter は Task.extra で素通しし、updatedAt は型に持たせない"
reversibility: high
tasks: [T-20260830-1132-task-frontmatter-unknown-fields-dropped]
createdAt: 2026-08-30T11:27:06.481Z
---

## 判断内容

タスクファイルの frontmatter のうち `Task` 型が知らないフィールドは、`Task.extra`
(任意の `Record<string, FrontmatterValue>`)へ退避し、`taskFrontmatter` が既知フィールドの後ろに
そのまま展開して書き戻す。`updatedAt` を `Task` の既知フィールドに昇格させることはしない。

## 理由

- ccloop 側は `updatedAt` を一度も読まず、設定もしない。既知フィールドにすると「誰がいつ更新するか」を
  新たに決める必要が生まれ、実装が増えるわりに得るものが無い。
- 失われて困るのは `updatedAt` だけではない。素通しにしておけば、共通ルールの改定やセッションが独自に
  書いたフィールドも同じ経路で保たれる。不具合の種類ごとにフィールドを増やす対処にしない。
- human-review 側の `closeHumanReview` は `parseFrontmatter` の生データを書き戻すため元から素通しで、
  タスクだけが非対称だった。素通しに揃えるほうが記録ファイル全体として一貫する。

## 検討した代替案

- **`updatedAt` を `Task` の既知フィールドにする**: 今回の実例(`ccloop abandon` で消えた)は直るが、
  他の未知フィールドは消え続ける。ccloop に読み書きの責務が無い値を型に載せる点も不自然。
- **`taskFromFile` が返す生データをまるごと保持して書き戻す**: 既知フィールドと生データの二重管理になり、
  どちらが正かが曖昧になる。既知キーを `KNOWN_TASK_FIELDS` で明示的に除外する形を採った。

## 影響範囲

- `KNOWN_TASK_FIELDS` と `taskFrontmatter` が返すキー集合は手で同期する必要がある。食い違うと未知
  フィールドの取りこぼし・重複が起きる。`Task` にフィールドを追加するときは両方を同時に更新する
  (コードにも同じ注意をコメントで置いた)。
- `taskFrontmatter` の出力にセッション由来のフィールドが混ざりうる。プロンプト注入にも同じ関数を
  使っているため、注入されるタスク frontmatter にもそれらが現れる(記録の忠実な再現なので許容する)。
