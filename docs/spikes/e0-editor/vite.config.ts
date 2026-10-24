import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@repo": "/Volumes/Projects/FunWind" } },
  server: { fs: { allow: ["/Volumes/Projects/FunWind", "."] } },
  build: { chunkSizeWarningLimit: 5000 },
});
