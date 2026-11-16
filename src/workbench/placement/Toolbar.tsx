// Placement toolbar: a vertical icon column at the left edge with the draw
// tools (rect/ellipse/polygon | crop + picture transforms | select/pan) and
// zoom controls, groups separated by thin lines. The new-component type
// picker lives in the panel header (TypeCombobox).

import { For, Show } from "solid-js";
import type { PlacementStore, Tool } from "./store";
import { WHEEL_ZOOM_FACTOR, fitView, scaleTo100, zoomAtPoint } from "./view";
import { sceneBounds, fitScene } from "./sceneGeometry";

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "rect", label: "Rect", key: "R" },
  { tool: "ellipse", label: "Ellipse", key: "E" },
  { tool: "square", label: "Square", key: "S" },
  { tool: "circle", label: "Circle", key: "O" },
  { tool: "polygon", label: "Polygon", key: "P" },
  { tool: "crop", label: "Crop", key: "C" },
  { tool: "select", label: "Select", key: "V" },
  { tool: "pan", label: "Pan", key: "H" },
];

/** Inline SVG icons in the titlebar style: stroke currentColor, no fill. */
function ToolIcon(props: { tool: Tool }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {props.tool === "select" && <path d="M4 2.5 12 8l-4 .8L6.4 13z" />}
      {props.tool === "rect" && <rect x="3" y="5" width="10" height="6" />}
      {props.tool === "ellipse" && <ellipse cx="8" cy="8" rx="5" ry="3.2" />}
      {props.tool === "square" && <rect x="4.5" y="4.5" width="7" height="7" />}
      {props.tool === "circle" && <circle cx="8" cy="8" r="3.75" />}
      {props.tool === "polygon" && <path d="M8 3l5.5 4-2.1 6H4.6L2.5 7z" />}
      {props.tool === "pan" && (
        <path d="M5.6 8.7V4.9a1.3 1.3 0 0 1 2.6 0v3m0-3.4a1.3 1.3 0 0 1 2.6 0v4m0-1a1.3 1.3 0 0 1 2.6 0v2.8a4 4 0 0 1-4 4h-.9a5 5 0 0 1-4-2l-1.6-2.3a1.5 1.5 0 0 1 2.3-1.9l.4.5" />
      )}
      {props.tool === "crop" && (
        <>
          <path d="M4.5 2v9.5a1 1 0 0 0 1 1H15" />
          <path d="M2 4.5h9.5a1 1 0 0 1 1 1V15" />
        </>
      )}
    </svg>
  );
}

/** Rotate 90° counterclockwise: circular arrow whose head points up-left. */
function RotateCcwIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.4 3.5A4.8 4.8 0 1 0 10.4 3.84" />
      <path d="M11.6 6.4 10.4 3.84 13.2 3.6" />
    </svg>
  );
}

/** Rotate 90° clockwise: mirrored twin of the CCW glyph (head up-right). */
function RotateCwIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.6 3.5A4.8 4.8 0 1 1 5.6 3.84" />
      <path d="M4.4 6.4 5.6 3.84 2.8 3.6" />
    </svg>
  );
}

/** Mirror about a vertical axis: triangles flipped left/right. */
function MirrorHIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 4.5v7l-4-3.5zM9.5 4.5v7l4-3.5z" />
    </svg>
  );
}

/** Mirror about a horizontal axis: triangles flipped top/bottom. */
function MirrorVIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.5h7L8 2.5zM4.5 9.5h7L8 13.5z" />
    </svg>
  );
}

function FitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
      <rect x="6" y="6" width="4" height="4" />
    </svg>
  );
}

export function Toolbar(props: { store: PlacementStore }) {
  const store = props.store;
  const hasBoard = () => Boolean(store.activeBoard());
  const hasContent = () => store.sceneBoards().length > 0 || store.sceneComponents().length > 0;
  const viewport = () => store.viewport();
  /** The picture the transform buttons act on: the selected (active), unlocked
   * board of an open document. */
  const transformTarget = () => {
    if (!store.doc() || !store.boardSelected()) return undefined;
    const board = store.activeBoard();
    return board && !board.locked ? board : undefined;
  };
  const fitScale = () => {
    if (!hasContent() || viewport().width === 0) return 1;
    // Fit works against the DISPLAYED (transformed) board size.
    return fitView(viewport(), sceneBounds(store.sceneBoards(), store.sceneComponents()), Number.POSITIVE_INFINITY).scale;
  };

  const zoom = (factor: number) => {
    const size = viewport();
    if (!hasContent() || size.width === 0) return;
    store.setView(
      zoomAtPoint(store.view(), { x: size.width / 2, y: size.height / 2 }, factor, fitScale()),
    );
  };

  return (
    <div class="pl-toolbar" role="toolbar" aria-label="Placement tools" aria-orientation="vertical">
      <For each={TOOLS}>
        {(entry) => (<>
          {/* Groups (shapes | crop-area | select/pan) are separated by thin
           * lines only; one more separator before the zoom cluster below. */}
          <Show when={entry.tool === "crop" || entry.tool === "select"}><span class="pl-toolbar-sep" aria-hidden="true" /></Show>
          <button
            class="pl-tool-btn"
            aria-pressed={store.tool() === entry.tool}
            aria-label={entry.label}
            title={`${entry.label} (${entry.key})`}
            disabled={entry.tool === "crop" ? !hasBoard() : !store.doc()}
            onClick={() => store.setTool(entry.tool)}
          >
            <ToolIcon tool={entry.tool} />
          </button>
          {/* Picture transforms ride with the crop group: icon-only buttons
           * acting on the selected unlocked picture. */}
          <Show when={entry.tool === "crop"}>
            <button
              class="pl-tool-btn"
              title="Rotate 90° CCW"
              aria-label="Rotate 90° CCW"
              disabled={!transformTarget()}
              onClick={() => { const board = transformTarget(); if (board) store.rotateBoard(board.id, -1); }}
            >
              <RotateCcwIcon />
            </button>
            <button
              class="pl-tool-btn"
              title="Rotate 90° CW"
              aria-label="Rotate 90° CW"
              disabled={!transformTarget()}
              onClick={() => { const board = transformTarget(); if (board) store.rotateBoard(board.id, 1); }}
            >
              <RotateCwIcon />
            </button>
            <button
              class="pl-tool-btn"
              title="Mirror vertical"
              aria-label="Mirror vertical"
              disabled={!transformTarget()}
              onClick={() => { const board = transformTarget(); if (board) store.flipBoard(board.id, "v"); }}
            >
              <MirrorVIcon />
            </button>
            <button
              class="pl-tool-btn"
              title="Mirror horizontal"
              aria-label="Mirror horizontal"
              disabled={!transformTarget()}
              onClick={() => { const board = transformTarget(); if (board) store.flipBoard(board.id, "h"); }}
            >
              <MirrorHIcon />
            </button>
          </Show>
        </>)}
      </For>
      <span class="pl-toolbar-sep" aria-hidden="true" />
      <button
        class="pl-tool-btn"
        title="Fit to view (0)"
        aria-label="Fit to view"
        disabled={!hasContent() || viewport().width === 0}
        onClick={() =>
          hasContent() && viewport().width && store.setView(fitScene(viewport(), store.sceneBoards(), undefined, store.sceneComponents()))
        }
      >
        <FitIcon />
      </button>
      <button
        class="pl-tool-btn pl-zoom-label"
        title="Zoom 100% (1)"
        aria-label="Zoom 100%"
        disabled={!hasContent() || viewport().width === 0}
        onClick={() => viewport().width && store.setView(scaleTo100(store.view(), viewport(), fitScale()))}
      >
        100%
      </button>
      <button
        class="pl-tool-btn"
        title="Zoom in (+)"
        aria-label="Zoom in"
        disabled={!hasContent() || viewport().width === 0}
        onClick={() => zoom(WHEEL_ZOOM_FACTOR)}
      >
        +
      </button>
      <button
        class="pl-tool-btn"
        title="Zoom out (−)"
        aria-label="Zoom out"
        disabled={!hasContent() || viewport().width === 0}
        onClick={() => zoom(1 / WHEEL_ZOOM_FACTOR)}
      >
        −
      </button>
    </div>
  );
}
