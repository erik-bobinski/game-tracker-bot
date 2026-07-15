import { Context } from "effect";

export class RiotApi extends Context.Service<RiotApi, {}>()(
  "app/RiotApiClient",
) {}
