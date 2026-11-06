import { defineConfig } from "vitest/config";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

export default defineConfig({
  plugins: [wgslVitePlugin()],
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
