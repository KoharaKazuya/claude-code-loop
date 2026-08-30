---
title: "探索の入力消費を打ち切る基準は「瞬時クラッシュ」で切る"
reversibility: high
tasks: [T-20260830-0413-explore-crash-input-hash]
createdAt: 2026-08-30T04:23:04.620Z
---

## 判断

探索セッションが人間の入力(GOAL.md の変更・Human Review の回答)を「確認済み」として消費する
(`state.inputsHash` / `goalHash` / `answeredKeys` を更新する)のは、そのセッションが
**瞬時クラッシュでなかった**ときに限る。判定は既存の `isFastCrash`(`lib/supervisor.ts`、
タイムアウトを除き `exitCode !== 0` かつ壁時計 `FAST_CRASH_MS` 未満)を共有する。

歯止めとして、直前の探索が瞬時クラッシュだった場合は `inputsDirty` によるクールダウン免除を
無効にする(`lib/scheduler.ts` の `idleCooldownPassed`)。瞬時クラッシュ後の再探索は
`exploreDue`(`explore.minIntervalMs` の経過)でしか成立しない。

## 理由

**切り分けの基準に exitCode 単独を使わない。** 異常終了には「起動直後のクラッシュ(何も読んで
いない)」と「締め切りによるタイムアウト(実際には作業済み)」が混ざる。後者まで未消費にすると、
取り込み済みの GOAL・回答を毎回読み直させ、探索がタイムアウトしがちな環境では前に進まなくなる。
壁時計時間を併用すれば「入力を読む機会すら無かった」ケースだけを落とせる。既に
`fastCrashStreak` が同じ意味で使っている判定なので、閾値と語彙を二重に持たずに済む。

**歯止めが要る理由。** 入力を未消費にすると `inputsDirty` が真のまま残る。`inputsDirty` は
空振りクールダウンを免除する規則(新しい人間の入力を待たせないため)を持つので、そのままだと
「クラッシュ → 未消費 → 即再探索 → クラッシュ」が全速で回る。免除を瞬時クラッシュ時だけ切れば、
再試行は `minIntervalMs`(既定 1 時間)に 1 回へ落ちる。実行可能タスクが無ければループは
idle-exit し、入力は未消費のまま次回 `ccloop run` に残る。

**停止条件は変えていない。** crash-backoff の閾値も idle-exit の条件も触っていない。歯止めは
既存のクールダウン(`exploreDue`)の適用範囲を狭めることだけで実現しており、タスクの制約に
抵触しない。

**フラグを永続化しない理由。** `lastExploreFastCrashed` はプロセス内変数であり、この抑制は
再起動で完全に外れる(再起動直後は `inputsDirty` による免除がそのまま効き、即座に再探索する)。
`ccloop run` を打ち直すのは人間が原因(claude の設定ミス等)を直して再開したときであり、そこで
`minIntervalMs` を待たせる意味がないため、この非対称性は意図的に受け入れる。副作用として、外部の
自動再起動(systemd 等)の下に置くと、クラッシュが続く間は再起動のたびに探索が起動しうる。
それでも入力が消費されることはないので、失われるのは再起動ごとの 1 回分のコストだけである。

## 検討した代替案

- **exitCode !== 0 なら一律に未消費**: タイムアウトした探索(実際には入力を読んでいる)を
  毎回読み直させる。取り込み済みの入力が延々と「新しい入力」として扱われる。
- **成功(exitCode === 0)以外は消費しない + 専用の再試行カウンタを state に持つ**: 上と同じ
  誤検知に加え、停止条件に近い新しい状態を増やす。既存のクールダウンで足りる。
- **探索の瞬時クラッシュを `fastCrashStreak` に数えて crash-backoff に載せる**:
  `D-20260830-0410-explore-crash-out-of-scope` のとおり、発火条件(実行可能タスクがある)を
  満たさないため効かず、タスク起動と衝突解消を巻き添えに抑制する害だけが残る。

## 影響範囲

`lib/supervisor.ts`(`isFastCrash` の切り出し、`runExploreSession` の戻り値と条件分岐、
`mainLoop` のフラグ)、`lib/scheduler.ts`(`LoopInput.lastExploreFastCrashed` と
`idleCooldownPassed`)、対応するテスト、`docs/architecture.md`、`CHANGELOG.md`。
`D-20260830-0410-explore-crash-out-of-scope` が「付随して見つかった別の欠陥」として挙げた経路は
これで塞がれた(同判断の結論そのものは変えていない)。
