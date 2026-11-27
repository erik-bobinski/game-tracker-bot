import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The bot serves the built site at /feed; in development vite serves it and
// passes the api and sign-in through to a bot running on PORT.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      ["/api", "/auth"].map((path) => [
        path,
        `http://localhost:${process.env.PORT ?? 3000}`,
      ]),
    ),
  },
});
