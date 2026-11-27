import { Router } from "@effect/ui";
import { BrowserHost, BrowserRouter } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { AppRoute, Feed } from "./feed.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  BrowserHost.mount(Feed, Router.props(AppRoute), root).pipe(
    Layer.provide([
      BrowserRouter.layer({ routes: AppRoute }),
      FetchHttpClient.layer,
    ]),
    Layer.launch,
    Effect.runFork,
  );
}
