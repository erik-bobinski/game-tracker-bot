import { RegistryProvider } from "@effect/atom-react";
import { Option, Schema } from "effect";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { FeedFilters } from "../../src/services/web/api.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Feed } from "./feed.tsx";
import "./styles.css";

const rootRoute = createRootRoute();
const router = createRouter({
  // the feed's filters live in the url, so a filtered view can be shared. The
  // url carries them as plain params (?game=lol,tft), not the json the router
  // writes by default (?game=["lol","tft"]). A link with a broken filter shows
  // the whole feed.
  parseSearch: (search) =>
    Schema.decodeUnknownOption(FeedFilters)(
      Object.fromEntries(new URLSearchParams(search)),
    ).pipe(Option.getOrElse(() => ({}))),
  stringifySearch: (search) => {
    const params = new URLSearchParams(
      Object.entries(Schema.encodeUnknownSync(FeedFilters)(search)).flatMap(
        ([key, value]) => (value === undefined ? [] : [[key, value]]),
      ),
    ).toString();
    return params ? `?${params}` : "";
  },
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/feed",
      // parseSearch has already decoded the url, so this checks the values
      validateSearch: Schema.toStandardSchemaV1(Schema.toType(FeedFilters)),
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
