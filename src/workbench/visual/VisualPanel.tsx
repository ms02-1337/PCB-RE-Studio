import { createComponentEditor } from "../electrical/ComponentEditor";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
} from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import type { PlacementStore } from "../placement/store";
import { ActionIcon } from "../ActionIcon";
import { TabScroller } from "../TabScroller";
import { ContextMenu } from "../placement/ContextMenu";
import { layerLabel } from "./model";
import type { VisualToolId } from "./toolController";
import { VisualSettingsModal } from "./VisualSettingsModal";
import { ValuePromptModal } from "./ValuePromptModal";
import { VisualCanvas, type VisualToolPrompt } from "./VisualCanvas";
import "./visual.css";
import { createCopperEditor } from "./CopperEditor";

const TOOLS: Array<{ id: VisualToolId; label: string; title: string }> = [
  {
    id: "measure",
    label: "Measure",
    title: "Measure distances between points",
  },
  {
    id: "calibrate",
    label: "Calibrate",
    title: "Set the PCB scale from a known length",
  },
  { id: "rotate", label: "Rotate", title: "Rotate the photograph" },
  {
    id: "align",
    label: "Align",
    title: "Align the photograph to reference points",
  },
  { id: "crop", label: "Crop", title: "Crop the photograph" },
  {
    id: "resize",
    label: "Resize",
    title: "Resize the photograph to real dimensions",
  },
  {
    id: "deskew",
    label: "Deskew",
    title: "Straighten the photograph by dragging its 4 corner handles",
  },
];
/** Tools that mutate image transforms: gated on the alignment lock and the
 * rewarp warning (AC24/AC25). */
const TRANSFORM_TOOLS = new Set<VisualToolId>([
  "rotate",
  "align",
  "crop",
  "resize",
  "deskew",
]);

export function VisualPanel(props: { store: PlacementStore; active: boolean }) {
  const visual = props.store.visual;
  const imagesById = createMemo(
    () =>
      new Map(
        visual.activePcb()?.images.map((image) => [image.id, image]) ?? [],
      ),
  );
  const [selected, setSelected] = createSignal<string | null>(null);
  const [activeTool, setActiveTool] = createSignal<VisualToolId | null>(null);
  const [copperFrame, setCopperFrame] = createSignal(0);
  const copper = createCopperEditor(
    props.store,
    () => props.active && !activeTool(),
    () => setCopperFrame((n) => n + 1),
    () => {
      setActiveTool(null);
      setPrompt(null);
    },
    () => components.open(),
  );
  const components = createComponentEditor(
    props.store,
    copper.layer,
    () => props.active && !activeTool() && copper.mode() === "select",
    () => setCopperFrame((n) => n + 1),
    copper.selectLayer,
  );
  const [flipX, setFlipX] = createSignal(false),
    [flipY, setFlipY] = createSignal(false);
  const [prompt, setPrompt] = createSignal<{
    request: VisualToolPrompt;
    reply: (value: number | null) => void;
  } | null>(null);
  const toolButtons: Partial<Record<VisualToolId, HTMLButtonElement>> = {};
  const selectedImage = createMemo(() => {
    const id = selected();
    return id ? (imagesById().get(id) ?? null) : null;
  });
  /** True when the canvas selection is a photograph: a sidebar/image
   * selection with no copper element or electrical component holding the
   * selection. Transform tools act on photographs only - components rotate
   * and resize from the Selection details panel instead. */
  const photoSelected = () =>
    Boolean(selectedImage()) && !copper.selected() && !components.selected();
  /** Evaluated inside JSX expressions so enablement tracks the live selection. */
  const toolState = (tool: {
    id: VisualToolId;
    label: string;
    title: string;
  }) => {
    // Measure works anywhere on the canvas, with or without a selection.
    if (tool.id === "measure") return { enabled: true, title: tool.title };
    const locked = TRANSFORM_TOOLS.has(tool.id) && selectedImage()?.locked === true;
    if (TRANSFORM_TOOLS.has(tool.id)) {
      return {
        enabled: photoSelected() && !locked,
        title: !photoSelected()
          ? `${tool.label}: select a photograph first`
          : locked
            ? `${tool.label}: unlock the photograph first`
            : tool.title,
      };
    }
    const image = selectedImage();
    return {
      enabled: Boolean(image),
      title: !image
        ? `${tool.label}: select a photograph first`
        : tool.title,
    };
  };
  const activateTool = (id: VisualToolId) => {
    if (activeTool() === id) {
      setActiveTool(null);
      return;
    } // canvas cancels the controller
    // Measure needs no photograph: it works on plain canvas geometry.
    if (id === "measure") {
      setActiveTool(id);
      return;
    }
    const image = selectedImage();
    if (!image) return;
    if (TRANSFORM_TOOLS.has(id)) {
      if (image.locked) return;
      if (
        image.warp ||
        image.perspective ||
        visual.activePcb()?.images.some((entry) => entry.warp || entry.perspective)
      ) {
        if (
          !window.confirm(
            `Transforming "${image.name}" may break existing alignments. Continue?`,
          )
        )
          return;
      }
    }
    setActiveTool(id);
  };
  const [cancelGeneration, setCancelGeneration] = createSignal(0);
  const [mirrorError, setMirrorError] = createSignal("");
  const mirrorAll = (axis: "horizontal" | "vertical") => {
    const pcb = visual.activePcb();
    if (!pcb?.images.length || pcb.images.some(image => image.locked)) return;
    if ((pcb.components?.length || pcb.traces?.length || pcb.zones?.length || pcb.vias?.length) && !window.confirm("All photographs will be mirrored together and remain aligned. Existing components and copper will stay in place and may need repositioning. Continue?")) return;
    setActiveTool(null);
    setPrompt(null);
    components.cancel();
    copper.cancel();
    setCancelGeneration(n => n + 1);
    setMirrorError(visual.mirrorAllImages(axis) ? "" : "Photographs could not be mirrored because a transform is invalid. No photographs were changed.");
  };
  const flipImage = (id: string, patch: { flipH?: boolean; flipV?: boolean }) => {
    if (visual.activePcb()?.images.some(image => image.warp) && !window.confirm("Flipping one photograph may break its alignment. Use Mirror all photographs to preserve the stack alignment. Continue?")) return;
    visual.updateImage(id, patch);
  };
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [opacityDraft, setOpacityDraft] = createSignal<{
    id: string;
    value: number;
  } | null>(null);
  const [leftOpen, setLeftOpen] = createSignal(true),
    [rightOpen, setRightOpen] = createSignal(true);
  const [leftWidth, setLeftWidth] = createSignal(290),
    [rightWidth, setRightWidth] = createSignal(300);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  let settingsButton: HTMLButtonElement | undefined;
  const [busy, setBusy] = createSignal(false);
  const [tabMenu, setTabMenu] = createSignal<{
    id: string;
    name: string;
    x: number;
    y: number;
    target: HTMLElement;
  } | null>(null);
  const [dragSource, setDragSource] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);
  let cardDrag: {
    id: string;
    pointerId: number;
    x: number;
    y: number;
    handle: HTMLButtonElement;
    started: boolean;
  } | null = null;
  const endCardDrag = (commit = false) => {
    const drag = cardDrag,
      target = dropTarget();
    cardDrag = null;
    setDragSource(null);
    setDropTarget(null);
    if (drag?.handle.hasPointerCapture?.(drag.pointerId))
      drag.handle.releasePointerCapture(drag.pointerId);
    if (commit && drag?.started && target && target !== drag.id) {
      visual.reorder(drag.id, target);
      focusImage(drag.id, true);
    }
  };
  const moveCardDrag = (event: PointerEvent) => {
    if (!cardDrag || event.pointerId !== cardDrag.pointerId) return;
    if (
      !cardDrag.started &&
      Math.hypot(event.clientX - cardDrag.x, event.clientY - cardDrag.y) < 5
    )
      return;
    cardDrag.started = true;
    setDragSource(cardDrag.id);
    const list = cardDrag.handle.closest<HTMLElement>(".ve-image-list");
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (event.clientY > bounds.top && event.clientY < bounds.top + 28)
        list.scrollTop -= 16;
      else if (
        event.clientY < bounds.bottom &&
        event.clientY > bounds.bottom - 28
      )
        list.scrollTop += 16;
    }
    const card = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-visual-image]");
    const id = card?.dataset.visualImage;
    setDropTarget(
      id &&
        id !== cardDrag.id &&
        visual.activePcb()?.images.some((image) => image.id === id)
        ? id
        : null,
    );
  };
  onCleanup(() => endCardDrag());
  let resize: { side: "left" | "right"; start: number; width: number } | null =
    null;
  let scene = "";
  const focusImage = (id: string | undefined, reorder = false) =>
    queueMicrotask(() => {
      const element = document.getElementById(
        `ve-${reorder ? "reorder" : "image"}-${id}`,
      );
      element?.focus();
    });
  createEffect(() => {
    const next = `${props.store.projectSession()}:${visual.activePcb()?.id}`;
    if (next !== scene) {
      scene = next;
      endCardDrag();
      setSelected(null);
      setRenaming(null);
      setOpacityDraft(null);
      setTabMenu(null);
      setSettingsOpen(false);
      setActiveTool(null);
      setFlipX(false);
      setFlipY(false);
      setPrompt(null);
    }
    if (!props.active) {
      setSettingsOpen(false);
      endCardDrag();
      setActiveTool(null);
      setPrompt(null);
    }
    if (
      selected() &&
      !visual.activePcb()?.images.some((image) => image.id === selected())
    )
      setSelected(null);
  });
  const startRename = (id: string, value: string) => {
    setRenaming(id);
    setName(value);
  };
  const finishRename = (tab: boolean) => {
    const id = renaming();
    if (id) {
      if (tab) visual.renamePcb(id, name());
      else visual.updateImage(id, { name: name().trim() });
    }
    setRenaming(null);
  };
  const renameInput = (tab: boolean) => (
    <input
      autofocus
      aria-label={tab ? "PCB name" : "Image name"}
      value={name()}
      onInput={(e) => setName(e.currentTarget.value)}
      onBlur={() => finishRename(tab)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finishRename(tab);
        if (e.key === "Escape") setRenaming(null);
        e.stopPropagation();
      }}
    />
  );
  const commitOpacity = () => {
    const draft = opacityDraft();
    if (draft) visual.updateImage(draft.id, { opacity: draft.value });
    setOpacityDraft(null);
  };
  const separator = (side: "left" | "right") => (
    <div
      class="ve-resizer"
      role="separator"
      aria-label={`Resize ${side === "left" ? "images" : "selection details"}`}
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={220}
      aria-valuemax={600}
      aria-valuenow={side === "left" ? leftWidth() : rightWidth()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        resize = {
          side,
          start: e.clientX,
          width: side === "left" ? leftWidth() : rightWidth(),
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!resize) return;
        const value = Math.max(
          220,
          Math.min(
            600,
            resize.width +
              (e.clientX - resize.start) * (side === "left" ? 1 : -1),
          ),
        );
        (side === "left" ? setLeftWidth : setRightWidth)(value);
      }}
      onPointerUp={() => {
        resize = null;
      }}
      onPointerCancel={() => {
        resize = null;
      }}
      onLostPointerCapture={() => {
        resize = null;
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const current = side === "left" ? leftWidth() : rightWidth();
        (side === "left" ? setLeftWidth : setRightWidth)(
          Math.max(
            220,
            Math.min(
              600,
              current +
                (e.key === "ArrowRight" ? 20 : -20) *
                  (side === "left" ? 1 : -1),
            ),
          ),
        );
      }}
    />
  );
  return (
    <div
      class="visual-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") endCardDrag();
      }}
    >
      <div class="ve-toolbar" role="toolbar" aria-label="Visual editor tools">
        <copper.Toolbar />
        <span class="ve-tool-separator" aria-hidden="true" />
        <For each={TOOLS}>
          {(tool) => (
            <button
              ref={(element) => {
                toolButtons[tool.id] = element;
              }}
              aria-pressed={activeTool() === tool.id ? "true" : "false"}
              classList={{ "is-active": activeTool() === tool.id }}
              disabled={!toolState(tool).enabled}
              title={toolState(tool).title}
              onClick={() => activateTool(tool.id)}
            >
              {tool.label}
            </button>
          )}
        </For>
        <span class="ve-tool-separator" aria-hidden="true" />
        <button
          aria-label="Flip view horizontally"
          title="Flip view horizontally"
          aria-pressed={flipX() ? "true" : "false"}
          classList={{ "is-active": flipX() }}
          disabled={!visual.activePcb()}
          onClick={() => setFlipX(!flipX())}
        >
          <ActionIcon name="Mirror horizontal" />
        </button>
        <button
          aria-label="Flip view vertically"
          title="Flip view vertically"
          aria-pressed={flipY() ? "true" : "false"}
          classList={{ "is-active": flipY() }}
          disabled={!visual.activePcb()}
          onClick={() => setFlipY(!flipY())}
        >
          <ActionIcon name="Mirror vertical" />
        </button>
        <button
          ref={settingsButton}
          class="ve-settings-button"
          aria-label="Visual editor settings"
          title="Visual editor settings"
          aria-haspopup="dialog"
          disabled={!visual.activePcb()}
          onClick={() => setSettingsOpen(true)}
        >
          <ActionIcon name="Settings" />
        </button>
      </div>
      <Show when={props.store.panelError()}>
        <p role="alert" class="ve-error">
          {props.store.panelError()}
        </p>
      </Show>
      <div class="ve-body">
        <aside
          class="ve-sidebar ve-left"
          style={{ width: leftOpen() ? `${leftWidth()}px` : "34px" }}
          aria-label="Images"
        >
          <div class="ve-heading">
            <Show when={leftOpen()}>
              <h2>Images</h2>
              <Show when={mirrorError()}><span role="alert">{mirrorError()}</span></Show>
              <For each={["horizontal", "vertical"] as const}>{axis => (
                <button
                  aria-label={`Mirror all photographs ${axis}ly`}
                  title={visual.activePcb()?.images.some(image => image.locked) ? "Unlock all photographs before mirroring the stack" : `Mirror all photographs ${axis}ly`}
                  disabled={!visual.activePcb()?.images.length || visual.activePcb()!.images.some(image => image.locked) || busy()}
                  onClick={() => mirrorAll(axis)}
                >{axis === "horizontal" ? "?" : "?"}</button>
              )}</For>
              <button
                class="ve-icon ve-add-image"
                aria-label="Add image"
                title="Add image"
                disabled={!props.store.doc() || !isTauri() || busy()}
                onClick={() => {
                  setBusy(true);
                  void props.store
                    .addVisualImageFlow()
                    .finally(() => setBusy(false));
                }}
              >
                <ActionIcon name="Add image" />
              </button>
            </Show>
            <button
              aria-label={leftOpen() ? "Hide images" : "Show images"}
              aria-expanded={leftOpen()}
              onClick={() => setLeftOpen(!leftOpen())}
            >
              {leftOpen() ? "‹" : "›"}
            </button>
          </div>
          <Show when={leftOpen()}>
            <div class="ve-image-list">
              <For
                each={[...(visual.activePcb()?.images ?? [])]
                  .reverse()
                  .map((image) => image.id)}
              >
                {(imageId) => {
                  const initialImage = imagesById().get(imageId)!;
                  const image = () => imagesById().get(imageId) ?? initialImage;
                  return (
                    <article
                      data-visual-image={image().id}
                      class="ve-image-card"
                      classList={{
                        selected: selected() === image().id,
                        "is-dragging": dragSource() === image().id,
                        "is-drop-target": dropTarget() === image().id,
                      }}
                      onClick={() => {
                        setSelected(image().id);
                        if (image().layerId)
                          copper.selectLayer(image().layerId!);
                      }}
                    >
                      <div class="ve-card-header">
                        <button
                          id={`ve-reorder-${image().id}`}
                          class="ve-icon ve-reorder"
                          title="Drag to reorder; arrow keys move image in stack"
                          aria-label={`Reorder ${image().name}`}
                          onPointerDown={(event) => {
                            if (event.button !== 0 || !props.active) return;
                            event.preventDefault();
                            event.currentTarget.focus();
                            cardDrag = {
                              id: image().id,
                              pointerId: event.pointerId,
                              x: event.clientX,
                              y: event.clientY,
                              handle: event.currentTarget,
                              started: false,
                            };
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                          }}
                          onPointerMove={moveCardDrag}
                          onPointerUp={(event) => {
                            if (cardDrag?.pointerId === event.pointerId) {
                              moveCardDrag(event);
                              endCardDrag(true);
                            }
                          }}
                          onPointerCancel={() => endCardDrag()}
                          onLostPointerCapture={() => endCardDrag()}
                          onKeyDown={(e) => {
                            if (e.key !== "ArrowUp" && e.key !== "ArrowDown")
                              return;
                            e.preventDefault();
                            const list = visual.activePcb()?.images ?? [];
                            const index = list.findIndex(
                              (entry) => entry.id === image().id,
                            );
                            const target =
                              list[index + (e.key === "ArrowUp" ? 1 : -1)];
                            if (target) {
                              visual.reorder(image().id, target.id);
                              focusImage(image().id, true);
                            }
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            aria-hidden="true"
                          >
                            <path
                              d="M4 2h1v1H4zM9 2h1v1H9zM4 6h1v1H4zM9 6h1v1H9zM4 10h1v1H4zM9 10h1v1H9z"
                              fill="currentColor"
                            />
                          </svg>
                        </button>
                        <button
                          class="ve-icon"
                          aria-label={`${image().visible ? "Hide" : "Show"} ${image().name}`}
                          title="Toggle visibility"
                          aria-pressed={image().visible}
                          onClick={() =>
                            visual.updateImage(image().id, {
                              visible: !image().visible,
                            })
                          }
                        >
                          <ActionIcon
                            name={image().visible ? "View" : "Hide"}
                          />
                        </button>
                        <Show
                          when={renaming() !== image().id}
                          fallback={renameInput(false)}
                        >
                          <button
                            id={`ve-image-${image().id}`}
                            class="ve-image-name"
                            title="Double-click or F2 to rename"
                            onDblClick={() =>
                              startRename(image().id, image().name)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "F2")
                                startRename(image().id, image().name);
                            }}
                          >
                            {image().name}
                          </button>
                        </Show>
                        <button
                          class="ve-icon ve-lock"
                          classList={{ "is-locked": image().locked }}
                          aria-label={`${image().locked ? "Unlock" : "Lock"} ${image().name}`}
                          title="Lock position and flips"
                          aria-pressed={image().locked}
                          onClick={() =>
                            visual.updateImage(image().id, {
                              locked: !image().locked,
                            })
                          }
                        >
                          <ActionIcon
                            name={image().locked ? "Lock" : "Unlock"}
                          />
                        </button>
                        <button
                          class="ve-icon"
                          aria-label={`Delete ${image().name}`}
                          title="Delete image"
                          onClick={() => {
                            if (
                              window.confirm(`Delete image '${image().name}'?`)
                            ) {
                              const remaining = visual
                                .activePcb()
                                ?.images.filter(
                                  (entry) => entry.id !== image().id,
                                );
                              visual.deleteImage(image().id);
                              focusImage(remaining?.at(-1)?.id);
                            }
                          }}
                        >
                          <ActionIcon name="Delete" />
                        </button>
                      </div>
                      <div class="ve-card-options">
                        <details
                          class="ve-flip"
                          onFocusOut={(e) => {
                            if (
                              !(e.relatedTarget instanceof Node) ||
                              !e.currentTarget.contains(e.relatedTarget)
                            )
                              e.currentTarget.open = false;
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.currentTarget.open = false;
                              e.currentTarget.querySelector("summary")?.focus();
                            }
                          }}
                        >
                          <summary>Flip</summary>
                          <div>
                            <label>
                              <input
                                type="checkbox"
                                checked={image().flipH}
                                disabled={image().locked}
                                onChange={(e) =>
                                  flipImage(image().id, {
                                    flipH: e.currentTarget.checked,
                                  })
                                }
                              />
                              Horizontal
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={image().flipV}
                                disabled={image().locked}
                                onChange={(e) =>
                                  flipImage(image().id, {
                                    flipV: e.currentTarget.checked,
                                  })
                                }
                              />
                              Vertical
                            </label>
                          </div>
                        </details>
                        <label>
                          Layer{" "}
                          <select
                            aria-label={`Layer for ${image().name}`}
                            value={image().layerId ?? ""}
                            onChange={(e) => {
                              const value = e.currentTarget.value;
                              visual.updateImage(image().id, {
                                layerId: value,
                              });
                              if (value) copper.selectLayer(value);
                            }}
                          >
                            <option value="">Unassigned</option>
                            <For each={visual.activePcb()?.layers}>
                              {(id, index) => (
                                <option value={id}>
                                  {layerLabel(
                                    index(),
                                    visual.activePcb()?.layers.length ?? 0,
                                  )}
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                      </div>
                      <label class="ve-opacity">
                        Opacity{" "}
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          aria-label={`Opacity for ${image().name}`}
                          value={
                            opacityDraft()?.id === image().id
                              ? opacityDraft()!.value * 100
                              : image().opacity * 100
                          }
                          onInput={(e) =>
                            setOpacityDraft({
                              id: image().id,
                              value: Number(e.currentTarget.value) / 100,
                            })
                          }
                          onChange={commitOpacity}
                          onPointerUp={commitOpacity}
                          onBlur={commitOpacity}
                          onPointerCancel={() => setOpacityDraft(null)}
                        />
                        <output>
                          {Math.round(
                            (opacityDraft()?.id === image().id
                              ? opacityDraft()!.value
                              : image().opacity) * 100,
                          )}
                          %
                        </output>
                      </label>
                    </article>
                  );
                }}
              </For>
              <Show when={!visual.activePcb()?.images.length}>
                <p class="muted">No images added.</p>
              </Show>
            </div>
          </Show>
        </aside>
        <Show when={leftOpen()}>{separator("left")}</Show>
        <VisualCanvas
          cancelGeneration={cancelGeneration()}
          copper={copper}
          components={components}
          copperFrame={copperFrame()}
          store={props.store}
          selected={selected()}
          select={setSelected}
          active={props.active}
          opacityDraft={opacityDraft()}
          tool={activeTool()}
          flipX={flipX()}
          flipY={flipY()}
          onToolEnd={() => setActiveTool(null)}
          onPrompt={(request, reply) => setPrompt({ request, reply })}
        />
        <Show when={rightOpen()}>{separator("right")}</Show>
        <aside
          class="ve-sidebar ve-right"
          aria-label="Selection details"
          style={{ width: rightOpen() ? `${rightWidth()}px` : "34px" }}
        >
          <div class="ve-heading">
            <Show when={rightOpen()}>
              <h2>Selection details</h2>
            </Show>
            <button
              aria-label={
                rightOpen()
                  ? "Hide selection details"
                  : "Show selection details"
              }
              aria-expanded={rightOpen()}
              onClick={() => setRightOpen(!rightOpen())}
            >
              {rightOpen() ? "›" : "‹"}
            </button>
          </div>
          <Show when={rightOpen()}>
            <Show when={components.current()} fallback={<copper.Inspector />}>
              <components.Inspector />
            </Show>
          </Show>
        </aside>
      </div>
      <TabScroller class="ve-tabs" label="Visual editor PCBs">
        <For each={visual.editor()?.pcbs}>
          {(pcb) => (
            <Show when={renaming() !== pcb.id} fallback={renameInput(true)}>
              <button
                aria-current={
                  visual.activePcb()?.id === pcb.id ? "true" : undefined
                }
                onClick={() => visual.activate(pcb.id)}
                onDblClick={() => startRename(pcb.id, pcb.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({
                    id: pcb.id,
                    name: pcb.name,
                    x: e.clientX,
                    y: e.clientY,
                    target: e.currentTarget,
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === "F2") startRename(pcb.id, pcb.name);
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  ) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTabMenu({
                      id: pcb.id,
                      name: pcb.name,
                      x: rect.left,
                      y: rect.top,
                      target: e.currentTarget,
                    });
                  }
                }}
              >
                {pcb.name}
              </button>
            </Show>
          )}
        </For>
        <button
          aria-label="Add visual PCB"
          disabled={!props.store.doc()}
          onClick={() => visual.addPcb()}
        >
          +
        </button>
      </TabScroller>
      <Show when={settingsOpen()}>
        <VisualSettingsModal
          store={props.store}
          restoreFocusTo={settingsButton ?? null}
          onClose={() => setSettingsOpen(false)}
          onCopperDefaults={(next) => copper.applyDefaults(next)}
        />
      </Show>
      <components.Manager />
      <copper.Dialog />
      <Show when={prompt()} keyed>
        {(state) => (
          <ValuePromptModal
            title={
              state.request.kind === "calibrate"
                ? "Calibrate PCB scale"
                : `Set real ${state.request.axis === "x" ? "width" : "height"}`
            }
            message={
              state.request.kind === "calibrate"
                ? `Measured ${state.request.spanPx.toFixed(1)} px. Enter the real length in mm:`
                : `Measured ${state.request.spanPx.toFixed(1)} px. Enter the real ${state.request.axis === "x" ? "width" : "height"} in mm:`
            }
            unit="mm"
            skipLabel={
              state.request.kind === "resizeAxis" ? "Skip this axis" : undefined
            }
            restoreFocusTo={
              activeTool() ? (toolButtons[activeTool()!] ?? null) : null
            }
            onConfirm={(value) => {
              setPrompt(null);
              state.reply(value);
            }}
            onCancel={() => {
              setPrompt(null);
              state.reply(null);
            }}
          />
        )}
      </Show>
      <Show when={tabMenu()} keyed>
        {(menu) => (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            restoreFocus={menu.target}
            onClose={() => setTabMenu(null)}
            items={[
              {
                label: "Delete PCB",
                run: () => {
                  if (
                    window.confirm(`Delete PCB '${menu.name}' and its images?`)
                  )
                    visual.deletePcb(menu.id);
                },
              },
            ]}
          />
        )}
      </Show>
    </div>
  );
}
