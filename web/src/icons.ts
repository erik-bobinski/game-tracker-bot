// The few icons the site draws, as Lucide draws them, in the text's colour.
// Decorative: whatever holds one says what it does.

import type { Html } from "@effect/ui/html";

const Icon = <M>(h: Html.H<M>, paths: ReadonlyArray<string>) =>
  h.svg
    .attrs({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    })
    .children(paths.map((d) => h.path.attr("d", d)));

// every game: four tiles
export const GridIcon = <M>(h: Html.H<M>) =>
  Icon(h, [
    "M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z",
    "M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z",
  ]);

export const CheckIcon = <M>(h: Html.H<M>) => Icon(h, ["M20 6 9 17l-5-5"]);

export const CloseIcon = <M>(h: Html.H<M>) =>
  Icon(h, ["M18 6 6 18", "m6 6 12 12"]);

export const SignOutIcon = <M>(h: Html.H<M>) =>
  Icon(h, [
    "m16 17 5-5-5-5",
    "M21 12H9",
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
  ]);
