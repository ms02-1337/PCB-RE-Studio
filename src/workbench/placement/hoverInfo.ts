// Hover summary: a module-level signal shared between the mapping canvas
// (writer) and the app status bar (reader). The workbench is a single-instance
// app with one canvas and one status bar, so a module signal avoids threading
// an extra prop through the whole tree.

import { createSignal } from "solid-js";

const [hoverSummary, setHoverSummary] = createSignal<string | null>(null);

export { hoverSummary, setHoverSummary };
