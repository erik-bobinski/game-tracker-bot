import { RegistryProvider } from "@effect/atom-react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GameId } from "../../src/services/game/index.ts";
import { Feed } from "./feed.tsx";
import "./styles.css";

// the feed's filters live in the url, so a filtered view can be shared
const FeedSearch = Schema.Struct({
  server: Schema.optional(Schema.String),
  game: Schema.optional(GameId),
  player: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Literals(["newest", "oldest"])),
});

const rootRoute = createRootRoute();
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/feed",
      validateSearch: Schema.toStandardSchemaV1(FeedSearch),
      component: Feed,
    }),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    </StrictMode>,
  );
}
