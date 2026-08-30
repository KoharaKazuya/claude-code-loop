/**
 * vitest の setupFiles(テストファイルごとに 1 回実行される)。
 *
 * 1. ccloop の実行時状態は `${XDG_STATE_HOME:-~/.local/state}/ccloop/<repo-id>` へ書かれる。
 *    テストは一時ディレクトリをリポジトリルートに見立てて Paths を作るため、そのままだと
 *    実行者の実 state ディレクトリへゴミが溜まる。テスト中だけ XDG_STATE_HOME を
 *    一時ディレクトリへ向け、終了時に丸ごと捨てる。
 *
 * 2. このリポジトリは ccloop 自身で自律運用されているため、`npm test` を実行するセッション自体が
 *    CLAUDE_AGENT_SESSION_KIND / CLAUDE_AGENT_AUTONOMOUS / CLAUDE_AGENT_TASK_ID などの
 *    CLAUDE_AGENT_* 環境変数を持つことがある。テストコードが子プロセスを spawn する際に
 *    `{ ...process.env }` を基点にすると、これらがそのまま漏れ、被テストコード側の
 *    「セッション種別による分岐」を意図せず変えてしまう。テスト対象は明示的に指定した
 *    env だけを見るべきなので、ここで一括削除して実行元セッションの影響を遮断する。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-test-state-"));
process.env.XDG_STATE_HOME = stateHome;

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_AGENT_")) delete process.env[key];
}

afterAll(() => {
  fs.rmSync(stateHome, { recursive: true, force: true });
});
