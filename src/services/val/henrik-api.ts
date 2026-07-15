import { Context } from "effect";

export class HenrikApiClient extends Context.Service<HenrikApiClient, {}>()(
  "app/HenrikApiClient",
) {}
