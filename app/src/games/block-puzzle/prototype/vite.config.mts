import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Separate entry and server: this is never imported by a production route.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../../", import.meta.url)) } },
  server: { host: "0.0.0.0", port: 3393, strictPort: true, allowedHosts: [".ts.net"] },
});
