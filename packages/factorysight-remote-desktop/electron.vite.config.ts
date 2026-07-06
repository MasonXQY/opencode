import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
    },
  },
})
