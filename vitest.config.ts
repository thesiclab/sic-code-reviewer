import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // No test may reach a real model API. tests/setup.ts makes fetch throw.
    setupFiles: ["tests/setup.ts"],
  },
});
