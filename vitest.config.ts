import { defineConfig } from "vitest/config";

// テスト対象を ccloop 本体(lib/)と開発用スクリプト(scripts/)に限定する。
// 配下に別リポジトリのチェックアウトや生成物が置かれても拾わないようにするため。
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["lib/test-setup.ts"],
    globalSetup: ["lib/test-global-setup.ts"],
  },
});
