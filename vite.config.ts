import { defineConfig } from "vite";
export default defineConfig({
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env": "{}",
  },
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "plugin.js",
    },
    minify: false,
    emptyOutDir: true,
  },
});
