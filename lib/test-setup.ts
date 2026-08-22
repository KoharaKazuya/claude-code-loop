/**
 * vitest の setupFiles(テストファイルごとに 1 回実行される)。
 *
 * ccloop の実行時状態は `${XDG_STATE_HOME:-~/.local/state}/ccloop/<repo-id>` へ書かれる。
 * テストは一時ディレクトリをリポジトリルートに見立てて Paths を作るため、そのままだと
 * 実行者の実 state ディレクトリへゴミが溜まる。テスト中だけ XDG_STATE_HOME を
 * 一時ディレクトリへ向け、終了時に丸ごと捨てる。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-test-state-"));
process.env.XDG_STATE_HOME = stateHome;

afterAll(() => {
  fs.rmSync(stateHome, { recursive: true, force: true });
});
