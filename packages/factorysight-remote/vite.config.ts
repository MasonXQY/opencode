import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "esnext",
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3080,
  },
})
