import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` for UI work: API calls go through the NGINX gateway (:8080) of the running cluster.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080" },
  },
});
