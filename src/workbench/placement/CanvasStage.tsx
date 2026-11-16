// Mapping canvas: renders every positioned image in the active tab plus shapes, drafts, handles,
// labels, tooltips, and the context menu. Pointer state runs through the pure
// pointerController; the store is written once per gesture on pointer-up.
// The picture is drawn inside the view ∘ board-transform context (crop →
// rotate → flip → scale), while overlays are drawn in screen space via
// imageToScreen.

import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ActionIcon } from "../ActionIcon";
import type { Board, Component, Point, Shape } from "./projectDoc";
import { UNASSIGNED_TYPE_ID } from "./projectDoc";
import type { PlacementStore, Tool } from "./store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import * as geo from "./geometry";
import { nextRefdes } from "./refdes";
import { labelColor, withAlpha } from "./color";
import * as controller from "./pointerController";
import {
  displayToImage,
  effectiveBoardTransform,
  imageToScreen,
  imageToScreenMatrix,
  visibleImageRect,
} from "./boardTransform";
import { WHEEL_ZOOM_FACTOR, scaleTo100, zoomAtPoint } from "./view";
import { fitScene, hitSceneImage, labelFontSize } from "./sceneGeometry";
import { setHoverSummary } from "./hoverInfo";
import { assetRead } from "../../bridge/project";

const ACCENT = "#ffcd11";
const QUARTER_THRESHOLD = 4096;
const SMALL_BITMAP_SCALE = 0.5;
const MIN_CROP_SIZE = 3;

interface BoardBitmaps {
  full: ImageBitmap;
  small?: ImageBitmap;
}

export function CanvasStage(props: { store: PlacementStore; onAddBoard: () => void }) {
  const store = props.store;
  const bitmapCache = new Map<string, BoardBitmaps>();
  const loading = new Set<string>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const bitmap of bitmapCache.values()) { bitmap.full.close(); bitmap.small?.close(); }
    bitmapCache.clear();
  });
  let wrap: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;

  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [hoverId, setHoverId] = createSignal<string | null>(null);
  const [tooltip, setTooltip] = createSignal<{ x: number; y: number; component: Component } | null>(null);
  const [readout, setReadout] = createSignal<{ x: number; y: number; text: string } | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [spaceDown, setSpaceDown] = createSignal(false);
  const [cursor, setCursor] = createSignal("default");
  /** Live crop-drag rectangle in image px (UI state; the store is written
   * only on pointer-up via setCropDraft, then once more on Apply). */
  const [cropDragRect, setCropDragRect] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);

  let imageDrag: { id: string; start: Point; origin: Point; current: Point } | null = null;
  const displayedBoard = (image: Board): Board => imageDrag?.id === image.id
    ? { ...image, sceneX: imageDrag.current.x, sceneY: imageDrag.current.y } : image;
  let draft: controller.Draft = controller.none;
  let cropDrag: { anchor: Point; current: Point } | null = null;
  let previewShape: Shape | undefined;
  let dirty = true;
  let raf = 0;

  const markDirty = () => {
    dirty = true;
    // Re-arm the (self-stopping) frame loop; no idle frames are scheduled.
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const board = () => store.activeBoard();
  const doc = () => store.doc();
  const view = () => store.view();
  const sceneComponents = createMemo(() => store.sceneComponents());
  const sceneIdentity = createMemo(() => `${store.projectSession()}:${store.activeMappingTab()?.id ?? ""}`);
  createEffect(() => {
    void sceneIdentity();
    imageDrag = null;
    cropDrag = null;
    draft = controller.none;
    previewShape = undefined;
    setCropDragRect(null);
    setReadout(null);
    setHoverId(null);
    setTooltip(null);
    setMenu(null);
    setHoverSummary(null);
  });
  /** Composite screen scale: view.scale × board.scale/100 (rotation and
   * flips never change lengths). */
  const compositeScale = () => view().scale;
  const fitScale = () => {
    const viewport = size();
    if (viewport.width === 0) return 1;
    return fitScene(viewport, store.sceneBoards(), Number.POSITIVE_INFINITY, sceneComponents()).scale;
  };
  const boardComponents = () => sceneComponents();

  const draw = () => {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dpr = window.devicePixelRatio || 1;
    const currentView = view();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Clear the whole backing store, not the CSS box: once sizes come from
    // devicePixelContentBoxSize the bitmap can exceed css × dpr by a device
    // pixel, and a CSS-sized clear would leave a stale edge.
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const image of store.sceneBoards()) {
    const active = displayedBoard(image);
    const isActive = active.id === board()?.id;
    const t = effectiveBoardTransform(active);
    const visible = t.crop ?? { x: 0, y: 0, w: active.width, h: active.height };
    const composite = currentView.scale * t.scale / 100;

    // Image-space pass: draw the picture and the shapes inside the composed
    // view ∘ board-transform context, clipped to the visible (cropped) rect.
    const matrix = imageToScreenMatrix(currentView, active);
    context.setTransform(
      dpr * matrix.a,
      dpr * matrix.b,
      dpr * matrix.c,
      dpr * matrix.d,
      dpr * matrix.e,
      dpr * matrix.f,
    );
    context.save();
    context.beginPath();
    context.rect(visible.x, visible.y, visible.w, visible.h);
    context.clip();

    const bitmaps = bitmapCache.get(active.assetHash);
    context.imageSmoothingEnabled = composite < 4;
    if (bitmaps) {
      const useSmall =
        bitmaps.small !== undefined &&
        composite < SMALL_BITMAP_SCALE &&
        Math.max(active.width, active.height) > QUARTER_THRESHOLD;
      // Both bitmaps stretch to the ORIGINAL image dims inside the transform.
      context.drawImage(useSmall ? bitmaps.small! : bitmaps.full, 0, 0, active.width, active.height);
    } else {
      context.fillStyle = "rgba(128, 128, 128, 0.18)";
      context.fillRect(0, 0, active.width, active.height);
      context.strokeStyle = "rgba(160, 160, 160, 0.4)";
      context.strokeRect(0, 0, active.width, active.height);
    }

    // Crop overlay in image space: darken everything outside the pending
    // rectangle (live drag or the apply-pending draft).
    const pendingCrop = isActive ? store.cropDraft() ?? (cropDrag ? cropDragRect() : null) : null;
    if (pendingCrop) {
      context.beginPath();
      context.rect(visible.x, visible.y, visible.w, visible.h);
      context.rect(pendingCrop.x, pendingCrop.y, pendingCrop.w, pendingCrop.h);
      context.fillStyle = "rgba(0, 0, 0, 0.45)";
      context.fill("evenodd");
      context.strokeStyle = ACCENT;
      context.lineWidth = 1.5 / composite;
      context.setLineDash([5 / composite, 4 / composite]);
      context.strokeRect(pendingCrop.x, pendingCrop.y, pendingCrop.w, pendingCrop.h);
      context.setLineDash([]);
    }
    context.restore();

    // Screen-space overlays: labels, padlocks, rubber band, handles.
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const transform = (p: Point) => imageToScreen(currentView, active, p);
    if (isActive && store.boardSelected() && !active.locked) {
      const rect = visibleImageRect(active);
      const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h }].map(transform);
      context.strokeStyle = ACCENT; context.lineWidth = 1.5;
      context.beginPath(); context.moveTo(corners[0].x, corners[0].y);
      for (const point of corners.slice(1)) context.lineTo(point.x, point.y);
      context.closePath(); context.stroke();
    }
    }
    // Markings form a scene overlay independent of all picture transforms.
    context.setTransform(dpr * currentView.scale, 0, 0, dpr * currentView.scale, dpr * currentView.offsetX, dpr * currentView.offsetY);
    for (const component of sceneComponents()) {
      drawShape(context, component.shape, colorOf(component), {
        hovered: hoverId() === component.id, selected: store.selectedId() === component.id,
        scale: currentView.scale, dashed: component.locked,
      });
    }
    if (previewShape) drawShape(context, previewShape, ACCENT, {
      hovered: false, selected: false, scale: currentView.scale, dashed: draft.kind === "polygon",
    });
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const transform = (point: Point) => ({ x: point.x * currentView.scale + currentView.offsetX, y: point.y * currentView.scale + currentView.offsetY });
    if (draft.kind === "polygon") {
      const a = transform(draft.points[draft.points.length - 1]);
      const b = transform(draft.cursor);
      context.strokeStyle = withAlpha(ACCENT, 0.9); context.lineWidth = 1;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    }
    for (const component of sceneComponents()) {
      drawLabel(context, component, colorOf(component), transform);
      if (component.locked) drawPadlock(context, component.shape, transform);
    }
    const selected = sceneComponents().find((component) => component.id === store.selectedId());
    if (selected && !selected.locked) drawHandles(context, selected.shape, transform);
  };

  const colorOf = (component: Component): string =>
    store.typeById(component.typeId)?.color ?? "#8a8a8a";

  const frame = () => {
    raf = 0;
    // Idle: stop the loop. markDirty() re-arms it on the next change.
    if (!dirty) return;
    dirty = false;
    draw();
    if (dirty && !raf) raf = requestAnimationFrame(frame);
  };

  const resize = (entries?: ResizeObserverEntry[]) => {
    if (!wrap || !canvas) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const next = { width: rect.width, height: rect.height };
    // Prefer the observer's device-pixel box (already snapped, no fractional
    // drift); the direct on-mount call has no entries and derives it instead.
    // The array can be empty per spec, hence the length guard.
    const box = entries?.[0]?.devicePixelContentBoxSize;
    const w = box?.length ? box[0].inlineSize : Math.max(1, Math.round(rect.width * dpr));
    const h = box?.length ? box[0].blockSize : Math.max(1, Math.round(rect.height * dpr));
    const previous = size();
    // Assigning canvas.width/height clears the bitmap even when the value is
    // unchanged, so a fully unchanged tick must skip every write and the
    // repaint entirely (no-op resizes must not blank the canvas).
    if (previous.width === next.width && previous.height === next.height && canvas.width === w && canvas.height === h) return;
    if (previous.width !== next.width || previous.height !== next.height) {
      setSize(next);
      store.setViewport(next);
    }
    // A fractional CSS change can round to the same device pixels; the
    // bitmap is only cleared (and only needs the synchronous repaint below)
    // when the backing store actually changes.
    if (canvas.width === w && canvas.height === h) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    // ResizeObserver fires after layout but BEFORE paint; leaving the
    // repaint to the frame loop would composite the just-cleared bitmap as a
    // blank frame on every resize tick (the sidebar-resize flicker). Paint
    // synchronously here — after the signal writes above (setSize runs the
    // fit effect, which may arm a frame via markDirty) — and drop any frame
    // this repaint supersedes.
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    dirty = false;
    draw();
  };

  let fittedScene = "";
  const fitIfNewBoard = () => {
    const images = store.sceneBoards();
    const viewport = size();
    if (viewport.width === 0 || viewport.height === 0) return;
    const key = store.projectSession() + ":" + store.activeMappingTab()?.id + ":" + images.map((image) => image.id).join(",");
    if (fittedScene === key) return;
    fittedScene = key;
    if (!images.length && !sceneComponents().length) return;
    store.setView(fitScene(viewport, images, undefined, sceneComponents()));
  };

  onMount(() => {
    // jsdom has no ResizeObserver; resize once and stay render-safe there.
    // The observer hands its entries to resize() so the backing store can
    // snap to devicePixelContentBoxSize instead of css × dpr.
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(wrap!);
    // The direct call has no entries (fallback sizing) and paints once,
    // synchronously; later invalidations go through markDirty's frame loop.
    resize();
    onCleanup(() => {
      observer?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    });
  });

  createEffect(() => {
    void doc();
    void view();
    void store.selectedId();
    void store.boardSelected();
    void hoverId();
    void cropDragRect();
    void store.cropDraft();
    markDirty();
  });

  createEffect(() => {
    void size();
    fitIfNewBoard();
  });

  createEffect(() => {
    void store.sceneBoards();
    fitIfNewBoard();
  });

  // Keep exactly the active scene's decoded images; pending reads are deduplicated.
  createEffect(() => {
    const images = store.sceneBoards();
    const hashes = new Set(images.map((image) => image.assetHash));
    for (const [hash, bitmap] of bitmapCache) {
      if (!hashes.has(hash)) { bitmap.full.close(); bitmap.small?.close(); bitmapCache.delete(hash); }
    }
    for (const image of images) {
      const hash = image.assetHash;
      if (bitmapCache.has(hash) || loading.has(hash)) continue;
      loading.add(hash);
      void (async () => {
        let full: ImageBitmap | undefined, small: ImageBitmap | undefined;
        try {
          const buffer = await assetRead(hash);
          if (disposed || typeof createImageBitmap !== "function") return;
          full = await createImageBitmap(new Blob([buffer]));
          if (Math.max(image.width, image.height) > QUARTER_THRESHOLD) {
            const quarter = document.createElement("canvas");
            quarter.width = Math.max(1, Math.round(full.width / 4));
            quarter.height = Math.max(1, Math.round(full.height / 4));
            const context = quarter.getContext("2d");
            if (context) { context.drawImage(full, 0, 0, quarter.width, quarter.height); small = await createImageBitmap(quarter); }
          }
          if (!disposed && store.sceneBoards().some((entry) => entry.assetHash === hash)) {
            bitmapCache.set(hash, { full, small }); full = undefined; small = undefined; markDirty();
          }
        } catch { /* Keep the neutral image placeholder on decode/read failure. */ }
        finally { loading.delete(hash); full?.close(); small?.close(); }
      })();
    }
    markDirty();
  });

  createEffect(() => {
    if (draft.kind !== "none" || cropDrag) return;
    setCursor(baselineCursor());
  });

  /** Cursor without any hover/drag context: per-tool baseline. */
  const baselineCursor = () =>
    store.tool() === "pan" ? "grab" : store.tool() === "select" ? "default" : "crosshair";

  /** Screen px → image px: undo the view math, then invert the board
   * transform. Falls back to display px when no board exists. */
  const localPoint = (event: PointerEvent | WheelEvent | MouseEvent): { board: Point; screen: Point } => {
    const rect = canvas!.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const currentView = view();
    const display = {
      x: (screen.x - currentView.offsetX) / currentView.scale,
      y: (screen.y - currentView.offsetY) / currentView.scale,
    };
    return { screen, board: display };
  };

  const world = (): controller.World => {
    const currentView = view();
    return {
      tool: store.tool(),
      components: boardComponents(),
      selectedId: store.selectedId(),
      scale: compositeScale(),
      view: currentView,
      spaceDown: spaceDown(),
      imageToScreen: (p) => ({ x: p.x * currentView.scale + currentView.offsetX, y: p.y * currentView.scale + currentView.offsetY }),
    };
  };

  const apply = (commands: controller.Command[]) => {
    for (const command of commands) {
      if (command.type === "select") {
        store.setSelectedId(command.id);
        // Clicking a component clears board selection; an empty-canvas click
        // with the select tool selects the board picture instead.
        if (command.id !== null) store.setBoardSelected(false);
        else if (store.tool() === "select") store.setBoardSelected(false);
      } else if (command.type === "view") store.setView(command.view);
      else if (command.type === "cursor") setCursor(command.cursor);
      else if (command.type === "updateShape") store.updateComponent(command.id, { shape: command.shape });
      else if (command.type === "add") {
        const active = board();
        const current = doc();
        if (!current) continue;
        const type = store.typeById(store.drawTypeId()) ?? current.types.find((t) => t.id === UNASSIGNED_TYPE_ID)!;
        const id = store.addComponent({
          boardId: active?.id ?? "",
          typeId: type.id,
          shape: command.shape,
          refdes: nextRefdes(type.prefix, current.components),
        });
        store.setTool("select");
        store.setSelectedId(id);
      }
    }
  };

  /** Clamps a crop rectangle into the currently visible image region. */
  const clampCropRect = (rect: { x: number; y: number; w: number; h: number }) => {
    const visible = visibleImageRect(board()!);
    const x1 = Math.max(visible.x, Math.min(rect.x, visible.x + visible.w));
    const y1 = Math.max(visible.y, Math.min(rect.y, visible.y + visible.h));
    const x2 = Math.max(visible.x, Math.min(rect.x + rect.w, visible.x + visible.w));
    const y2 = Math.max(visible.y, Math.min(rect.y + rect.h, visible.y + visible.h));
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  };

  const onPointerDown = (event: PointerEvent) => {
    canvas?.focus();
    setMenu(null);
    const point = localPoint(event);
    if (event.button === 0 && !spaceDown() && store.tool() !== "pan" && draft.kind === "none") {
      const hit = hitSceneImage(store.sceneBoards(), point.board);
      const componentHit = [...sceneComponents()].reverse().find((component) => geo.shapeHit(component.shape, point.board, controller.HIT_TOLERANCE / compositeScale()));
      // A selected component's resize handles retain priority over image dragging.
      const nearHandle = controller.handleHit(world(), point.screen);
      if (store.tool() === "select" && !componentHit && !nearHandle) {
        store.setSelectedId(null); store.setBoardSelected(Boolean(hit));
        if (!hit) { markDirty(); return; }
        if (hit.id !== board()?.id) store.activateBoard(hit.id);
        store.setBoardSelected(true);
        if (!hit.locked) {
          const origin = { x: hit.sceneX ?? 0, y: hit.sceneY ?? 0 };
          imageDrag = { id: hit.id, start: point.screen, origin, current: origin };
          canvas?.setPointerCapture(event.pointerId); setCursor("move");
        }
        setHoverId(null); setTooltip(null); markDirty(); return;
      }
      if (store.tool() === "crop") {
        if (!hit) return;
        if (hit.id !== board()?.id) store.activateBoard(hit.id);
        store.setSelectedId(null); store.setBoardSelected(true);
      }
    }
    // Crop tool: left-drag defines the new crop rect in image px. Panning
    // (middle button / Space) still wins over cropping.
    if (store.tool() === "crop" && event.button === 0 && !spaceDown() && board()) {
      const local = displayToImage(board()!, point.board);
      cropDrag = { anchor: local, current: local };
      setCropDragRect(null);
      store.setCropDraft(null);
      canvas?.setPointerCapture(event.pointerId);
      setHoverId(null);
      setTooltip(null);
      markDirty();
      return;
    }
    const step = controller.pointerDown(draft, {
      boardPoint: point.board,
      screenPoint: point.screen,
      button: event.button,
      shift: event.shiftKey,
    }, world());
    draft = step.draft;
    apply(step.commands);
    if (draft.kind !== "none") {
      canvas?.setPointerCapture(event.pointerId);
      setHoverId(null);
      setTooltip(null);
    }
    previewShape = undefined;
    markDirty();
  };

  /** Hover lookup at a scene point (no active drag): topmost component hit,
   * the one-line status-bar summary, and the Select-tool cursor — a handle of
   * the selected unlocked shape wins with its direction cursor, then an
   * unlocked component or picture reads "move", a locked one
   * "not-allowed", otherwise the tool baseline. */
  const hoverState = (point: { board: Point; screen: Point }): {
    component?: Component;
    summary: string | null;
    cursor: string;
  } => {
    const component = [...sceneComponents()].reverse().find((entry) =>
      geo.shapeHit(entry.shape, point.board, controller.HIT_TOLERANCE / view().scale));
    const picture = component ? undefined : hitSceneImage(store.sceneBoards(), point.board);
    let cursor = baselineCursor();
    if (store.tool() === "select") {
      const handle = controller.handleHit(world(), point.screen);
      if (handle) {
        cursor = handle.kind === "rectResize" || handle.kind === "ellipseResize"
          ? controller.cursorForHandle(handle.handle)
          : "move";
      } else if (component) {
        cursor = component.locked ? "not-allowed" : "move";
      } else if (picture) {
        cursor = picture.locked ? "not-allowed" : "move";
      }
    }
    const summary = component
      ? [component.refdes, typeChip(component).name, component.partNumber || component.value || component.marking]
          .filter(Boolean)
          .join(" · ")
      : picture?.name ?? null;
    return { component, summary, cursor };
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = localPoint(event);
    if (imageDrag) {
      imageDrag.current = { x: imageDrag.origin.x + (point.screen.x - imageDrag.start.x) / view().scale, y: imageDrag.origin.y + (point.screen.y - imageDrag.start.y) / view().scale };
      markDirty(); return;
    }
    if (cropDrag) {
      if (!board()) return;
      cropDrag.current = displayToImage(board()!, point.board);
      const rect = geo.normalizeRect(cropDrag.anchor, cropDrag.current);
      setCropDragRect(clampCropRect(rect));
      markDirty();
      return;
    }
    if (draft.kind === "none") {
      const hover = hoverState(point);
      setHoverId(hover.component?.id ?? null);
      setTooltip(hover.component ? { x: event.clientX, y: event.clientY, component: hover.component } : null);
      setHoverSummary(hover.summary);
      setCursor(hover.cursor);
      markDirty();
      return;
    }
    const step = controller.pointerMove(draft, {
      boardPoint: point.board,
      screenPoint: point.screen,
      button: event.button,
      shift: event.shiftKey,
    }, world());
    draft = step.draft;
    previewShape = step.preview;
    apply(step.commands);
    if (draft.kind === "rect" || draft.kind === "ellipse") {
      const box = previewShape ? geo.bbox(previewShape) : null;
      if (box) {
        setReadout({
          x: event.clientX + 16,
          y: event.clientY + 16,
          text: `${Math.round(box.w)} × ${Math.round(box.h)} px`,
        });
      }
    }
    markDirty();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (imageDrag) {
      const drag = imageDrag; imageDrag = null;
      if (drag.current.x !== drag.origin.x || drag.current.y !== drag.origin.y) store.updateBoard(drag.id, { sceneX: drag.current.x, sceneY: drag.current.y });
      setCursor("default"); markDirty(); return;
    }
    if (cropDrag) {
      const rect = cropDragRect();
      cropDrag = null;
      if (rect && rect.w >= MIN_CROP_SIZE && rect.h >= MIN_CROP_SIZE) {
        // One store write per gesture: the rect becomes the pending draft,
        // confirmed separately via applyCrop()/cancelCrop().
        setCropDragRect(null);
        store.setCropDraft(rect);
      } else {
        setCropDragRect(null);
      }
      markDirty();
      return;
    }
    if (draft.kind === "none") return;
    const point = localPoint(event);
    const step = controller.pointerUp(draft, {
      boardPoint: point.board,
      screenPoint: point.screen,
      button: event.button,
      shift: event.shiftKey,
    }, world());
    draft = controller.none;
    previewShape = undefined;
    setReadout(null);
    apply(step.commands);
    markDirty();
  };

  const closeDraftPolygon = () => {
    const step = controller.closePolygon(draft);
    if (step.draft.kind === "none" && draft.kind === "polygon") {
      draft = step.draft;
      previewShape = undefined;
      apply(step.commands);
      markDirty();
    }
  };

  const zoomKeys = (event: KeyboardEvent) => {
    const viewport = size();
    if (viewport.width === 0) return false;
    // Zoom/fit work against the DISPLAYED (transformed) board size.
    if (event.key === "0") {
      store.setView(fitScene(viewport, store.sceneBoards(), undefined, sceneComponents()));
      return true;
    }
    if (event.key === "1") {
      store.setView(scaleTo100(view(), viewport, fitScale()));
      return true;
    }
    if (event.key === "+" || event.key === "=") {
      store.setView(zoomAtPoint(view(), { x: viewport.width / 2, y: viewport.height / 2 }, WHEEL_ZOOM_FACTOR, fitScale()));
      return true;
    }
    if (event.key === "-" || event.key === "_") {
      store.setView(zoomAtPoint(view(), { x: viewport.width / 2, y: viewport.height / 2 }, 1 / WHEEL_ZOOM_FACTOR, fitScale()));
      return true;
    }
    return false;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        event.preventDefault();
        imageDrag = null; cropDrag = null; draft = controller.none; previewShape = undefined; setCropDragRect(null);
        if (key === "y" || event.shiftKey) store.redo(); else store.undo();
        markDirty();
      } else if (key === "d") {
        event.preventDefault();
        const id = store.selectedId();
        if (id) store.duplicateComponent(id);
      }
      return; // Ctrl+S and other shortcuts are handled globally.
    }
    if (event.key === " ") {
      event.preventDefault();
      setSpaceDown(true);
      return;
    }
    const tools: Record<string, Tool> = {
      v: "select",
      r: "rect",
      e: "ellipse",
      p: "polygon",
      h: "pan",
      c: "crop",
    };
    const tool = tools[event.key.toLowerCase()];
    if (tool) {
      store.setTool(tool);
      return;
    }
    if (draft.kind === "polygon" && (event.key === "Enter" || event.key === "Backspace" || event.key === "Escape")) {
      event.preventDefault();
      const step = controller.keyDown(draft, event.key, world());
      draft = step.draft;
      apply(step.commands);
      markDirty();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (imageDrag) { imageDrag = null; setCursor("default"); markDirty(); return; }
      if (cropDrag) {
        // A crop drag in progress: discard it without committing a draft.
        cropDrag = null;
        setCropDragRect(null);
        markDirty();
        return;
      }
      if (store.cropDraft()) {
        store.cancelCrop();
        markDirty();
        return;
      }
      const step = controller.keyDown(draft, event.key, world());
      draft = step.draft;
      apply(step.commands);
      // Escape also clears the board-picture selection (after apply, which
      // may have re-selected the board for an emptied component selection).
      if (store.boardSelected()) store.setBoardSelected(false);
      markDirty();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && draft.kind === "none") {
      event.preventDefault();
      const selected = store.selectedComponent();
      if (selected && !selected.locked) store.deleteComponent(selected.id);
      return;
    }
    if (event.key.startsWith("Arrow") && draft.kind === "none") {
      const selected = store.selectedComponent();
      if (!selected || selected.locked) return;
      event.preventDefault();
      const distance = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0;
      const dy = event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0;
      store.updateComponent(selected.id, { shape: geo.moveShape(selected.shape, dx, dy) });
      return;
    }
    if (zoomKeys(event)) event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === " ") setSpaceDown(false);
  };

  const onWheel = (event: WheelEvent) => {
    const viewport = size();
    event.preventDefault();
    event.stopPropagation();
    if (viewport.width === 0) return;
    const point = localPoint(event);
    const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
    store.setView(zoomAtPoint(view(), point.screen, factor, fitScale()));
  };

  const menuItems = (): MenuItem[] => {
    const point = menu();
    const components = boardComponents();
    if (!point) return [];
    const hit = [...components].reverse().find((component) => geo.shapeHit(component.shape, localBoardPoint(point), controller.HIT_TOLERANCE / compositeScale()));
    if (hit) {
      const selected = store.selectedId() === hit.id;
      const items: MenuItem[] = [
        { label: "Duplicate", shortcut: "Ctrl+D", run: () => store.duplicateComponent(hit.id) },
        {
          label: hit.locked ? "Unlock" : "Lock",
          run: () => store.updateComponent(hit.id, { locked: !hit.locked }),
        },
        { label: "Bring to front", run: () => store.bringToFront(hit.id), disabled: hit.locked, reason: "Component is locked" },
        { label: "Send to back", run: () => store.sendToBack(hit.id), disabled: hit.locked, reason: "Component is locked" },
      ];
      if (!selected) items.unshift({ label: "Select", run: () => store.setSelectedId(hit.id) });
      items.push({
        label: "Delete",
        shortcut: "Del",
        disabled: hit.locked,
        reason: "Component is locked",
        run: () => store.deleteComponent(hit.id),
      });
      return items;
    }
    return [
      { label: "Add board image…", run: props.onAddBoard },
      { label: "Fit to view", shortcut: "0", run: () => size().width && store.setView(fitScene(size(), store.sceneBoards(), undefined, sceneComponents())) },
      { label: "Zoom 100%", shortcut: "1", run: () => size().width && store.setView(scaleTo100(view(), size(), fitScale())) },
    ];
  };

  const localBoardPoint = (point: { x: number; y: number }): Point => {
    const rect = canvas?.getBoundingClientRect() ?? new DOMRect();
    const screen = { x: point.x - rect.left, y: point.y - rect.top };
    const currentView = view();
    const display = {
      x: (screen.x - currentView.offsetX) / currentView.scale,
      y: (screen.y - currentView.offsetY) / currentView.scale,
    };
    return display;
  };

  /** Screen-space position for the crop Apply/Cancel chips: anchored at the
   * bottom-right corner of the pending rect, clamped into the canvas wrap. */
  const cropChipPosition = (rect: { x: number; y: number; w: number; h: number }) => {
    const active = board();
    const viewport = size();
    if (!active) return { left: 8, top: 8 };
    const corner = imageToScreen(view(), active, { x: rect.x + rect.w, y: rect.y + rect.h });
    return {
      left: Math.max(4, Math.min(corner.x - 8, viewport.width - 120)),
      top: Math.max(4, Math.min(corner.y + 6, viewport.height - 34)),
    };
  };

  const typeChip = (component: Component) => {
    const type = store.typeById(component.typeId);
    return { color: type?.color ?? "#8a8a8a", name: type?.name ?? "Unassigned" };
  };

  return (
    <div class="canvas-wrap" ref={wrap}>
      <canvas
        ref={canvas}
        role="application"
        aria-label="Board canvas: draw and edit component markings"
        tabIndex={0}
        style={{ cursor: cursor() }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { imageDrag = null; cropDrag = null; draft = controller.none; previewShape = undefined; setCropDragRect(null); setReadout(null); setHoverSummary(null); setCursor(baselineCursor()); markDirty(); }}
        onPointerLeave={() => {
          // Leaving the canvas drops every hover affordance; an active drag
          // (pointer capture) must keep its own cursor and state.
          if (draft.kind !== "none" || imageDrag || cropDrag) return;
          setHoverId(null);
          setTooltip(null);
          setHoverSummary(null);
          setCursor(baselineCursor());
          markDirty();
        }}
        onDblClick={() => closeDraftPolygon()}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      />
      <Show when={tooltip()} keyed>
        {(tip) => {
          const chip = typeChip(tip.component);
          const info = tip.component;
          return (
            <div
              class="canvas-tooltip"
              role="tooltip"
              style={{
                left: `${Math.min(tip.x + 14, window.innerWidth - 220)}px`,
                top: `${Math.min(tip.y + 14, window.innerHeight - 120)}px`,
              }}
            >
              <strong>{info.refdes}</strong>
              <span class="tip-type">
                <span class="tip-dot" style={{ background: chip.color }} aria-hidden="true" />
                {chip.name}
              </span>
              <span>{info.partNumber || info.value || "—"}</span>
              <Show when={info.marking}>
                <span class="tip-marking">Marking: {info.marking}</span>
              </Show>
              <Show when={info.locked}>
                <span class="tip-locked">Locked</span>
              </Show>
            </div>
          );
        }}
      </Show>
      <Show when={readout()} keyed>
        {(item) => (
          <div class="canvas-readout" style={{ left: `${item.x}px`, top: `${item.y}px` }}>
            {item.text}
          </div>
        )}
      </Show>
      <Show when={store.cropDraft()} keyed>
        {(rect) => {
          const pos = cropChipPosition(rect);
          const locked = board()?.locked ?? false;
          return (
            <div
              class="pl-crop-chips"
              style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
              data-testid="crop-chips"
            >
              <button
                class="pl-crop-apply"
                disabled={locked}
                title={locked ? "Picture is locked — unlock to crop" : "Apply the crop"}
                onClick={() => {
                  store.applyCrop();
                  markDirty();
                }}
              >
                <ActionIcon name="apply" />
                Apply crop
              </button>
              <button
                class="pl-crop-cancel"
                onClick={() => {
                  store.cancelCrop();
                  markDirty();
                }}
              >
                <ActionIcon name="cancel" />
                Cancel
              </button>
            </div>
          );
        }}
      </Show>
      <Show when={menu()} keyed>
        {(point) => (
          <ContextMenu
            x={point.x}
            y={point.y}
            items={menuItems()}
            onClose={() => setMenu(null)}
            restoreFocus={canvas ?? null}
          />
        )}
      </Show>
    </div>
  );
}

function drawShape(
  context: CanvasRenderingContext2D,
  shape: Shape,
  color: string,
  options: { hovered: boolean; selected: boolean; scale: number; dashed?: boolean },
): void {
  const alpha = options.hovered ? 0.32 : 0.22;
  context.fillStyle = withAlpha(color, alpha);
  context.strokeStyle = color;
  context.lineWidth = 1.5 / options.scale;
  context.setLineDash(options.dashed ? [4 / options.scale, 3 / options.scale] : []);
  context.beginPath();
  if ("rect" in shape) {
    context.rect(shape.rect.x, shape.rect.y, shape.rect.w, shape.rect.h);
  } else if ("ellipse" in shape) {
    context.ellipse(shape.ellipse.cx, shape.ellipse.cy, shape.ellipse.rx, shape.ellipse.ry, 0, 0, Math.PI * 2);
  } else {
    const points = shape.polygon.points;
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
  }
  context.fill();
  context.stroke();
  if (options.selected) {
    const pad = 2 / options.scale;
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.5 / options.scale;
    context.setLineDash([]);
    const box = geo.bbox(shape);
    context.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
  }
  context.setLineDash([]);
}

export function drawLabel(
  context: CanvasRenderingContext2D,
  component: Component,
  color: string,
  transform: (point: Point) => Point,
): void {
  const shape = component.shape;
  const box = geo.bbox(shape);
  const a = transform({ x: box.x, y: box.y });
  const b = transform({ x: box.x + box.w, y: box.y + box.h });
  const size = labelFontSize(Math.abs(b.x - a.x), Math.abs(b.y - a.y), component.refdes.length);
  if (size === null) return;
  context.save();
  context.beginPath();
  if ("ellipse" in shape) {
    const center = transform({ x: shape.ellipse.cx, y: shape.ellipse.cy });
    context.ellipse(center.x, center.y, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
  } else {
    const points = "polygon" in shape ? shape.polygon.points : [
      { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h },
    ];
    const first = transform(points[0]); context.moveTo(first.x, first.y);
    for (const point of points.slice(1)) { const screen = transform(point); context.lineTo(screen.x, screen.y); }
    context.closePath();
  }
  context.clip();
  const center = transform(geo.center(shape));
  const textColor = labelColor(color);
  context.font = `bold ${size}px "Segoe UI", system-ui, sans-serif`;
  context.textAlign = "center"; context.textBaseline = "middle";
  context.lineWidth = 2; context.strokeStyle = textColor === "#111827" ? "#f9fafb" : "#111827";
  context.strokeText(component.refdes, center.x, center.y);
  context.fillStyle = textColor; context.fillText(component.refdes, center.x, center.y);
  context.restore();
}

function drawPadlock(
  context: CanvasRenderingContext2D,
  shape: Shape,
  transform: (point: Point) => Point,
): void {
  const box = geo.bbox(shape);
  const corner = transform({ x: box.x + box.w, y: box.y });
  // Vector padlock (screen px): shackle arc + body rect, stroked twice —
  // a dark halo pass for contrast on any board, then the light glyph —
  // matching the stroke-line style of the titlebar icons.
  const width = 11;
  const height = 10;
  const left = corner.x - width - 6;
  const top = corner.y + 3;
  const bodyTop = top + height * 0.45;
  const radius = width * 0.28;
  const centerX = left + width / 2;
  const passes: Array<[string, number]> = [
    ["#111827", 4],
    ["#f9fafb", 1.5],
  ];
  for (const [color, lineWidth] of passes) {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineJoin = "round";
    context.beginPath();
    context.arc(centerX, bodyTop, radius, Math.PI, 0);
    context.moveTo(left, bodyTop);
    context.rect(left, bodyTop, width, height * 0.55);
    context.stroke();
  }
}

function drawHandles(
  context: CanvasRenderingContext2D,
  shape: Shape,
  transform: (point: Point) => Point,
): void {
  const points: Point[] = [];
  if ("rect" in shape) {
    points.push(...geo.rectHandlePoints(shape.rect).map((handle) => handle.point));
  } else if ("ellipse" in shape) {
    points.push(...geo.ellipseHandlePoints(shape.ellipse).map((handle) => handle.point));
  } else {
    points.push(...shape.polygon.points);
    for (let edge = 0; edge < shape.polygon.points.length; edge++) {
      const a = shape.polygon.points[edge];
      const b = shape.polygon.points[(edge + 1) % shape.polygon.points.length];
      points.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  }
  for (const point of points) {
    const screen = transform(point);
    context.fillStyle = ACCENT;
    context.strokeStyle = "#181818";
    context.lineWidth = 1;
    context.fillRect(screen.x - 3.5, screen.y - 3.5, 7, 7);
    context.strokeRect(screen.x - 3.5, screen.y - 3.5, 7, 7);
  }
}
