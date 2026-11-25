import { FetchHttpClient } from "effect/http";
import { AtomHttpApi } from "effect/reactivity";
import { SiteApi } from "../../src/services/web/api.ts";

// The bot's api, from the same contract the server implements. The session
// cookie rides along on every same-origin request.
export class Site extends AtomHttpApi.Service<Site>()("Site", {
  api: SiteApi,
  httpClient: FetchHttpClient.layer,
}) {}
