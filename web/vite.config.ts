import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The bot serves the built site at /feed; in development vite serves it and
// passes the api and sign-in through to a bot running on PORT.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  // React, the router and Effect's http client come to ~170 KB gzipped,
  // loaded once for the whole site
  build: { chunkSizeWarningLimit: 600 },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/auth"].map((path) => [
        path,
        `http://localhost:${process.env.PORT ?? 3000}`,
      ]),
    ),
  },
});
