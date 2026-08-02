import { Schema } from "effect";

export const ProviderName = Schema.Literals(["riot", "henrik"]);

export class ProviderNotFound extends Schema.TaggedErrorClass<ProviderNotFound>()(
  "ProviderNotFound",
  {
    provider: ProviderName,
    operation: Schema.String,
  },
) {}

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()(
  "ProviderError",
  {
    provider: ProviderName,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}
