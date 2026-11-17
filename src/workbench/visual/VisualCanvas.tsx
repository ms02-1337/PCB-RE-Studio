import type { createComponentEditor } from "../electrical/ComponentEditor";
import { Show, on, createSignal, createEffect, onCleanup, onMount } from "solid-js";
import { assetRead } from "../../bridge/project";
import { hitVisualImage, type VisualImage, type VisualPcb } from "./model";
import { padPoint, footprintBounds } from "../electrical/domain";
import type { PlacementStore } from "../placement/store";
import type { Point } from "../placement/projectDoc";
import {
  createVisualToolController,
  type OverlayView,
  type ToolIntent,
  type VisualToolId,
} from "./toolController";
import {
  affineFromTriangle,
  effectiveVisualTransform,
  imageAnchor,
  imageLinear,
  perspectiveMesh,
  worldAabb,
  worldFootprint,
  worldToSource,
} from "./transform";
import { drawVisualOverlays, screenToBase, screenToWorld } from "./overlays";
import type { CopperEditor } from "./CopperEditor";
import { pruneComponentReferences } from "../electrical/actions";

/** Seam overdraw: each clipped mesh triangle is inflated this many CSS px
 * beyond its vertices (radially from the centroid) so adjacent triangles
 * overlap instead of showing hairline seams from rasterizer rounding. */
const SEAM_OVERDRAW_PX = 0.75;

/** Measure/calibrate never touch the captured image; this placeholder keeps
 * the frozen begin(image) contract satisfied when no photograph exists. Its
 * empty id is falsy, so the "target disappeared" guard never fires. */
const MEASURE_PLACEHOLDER: VisualImage = {
  id: "", name: "", assetHash: "", width: 0, height: 0, x: 0, y: 0,
  flipH: false, flipV: false, visible: true, opacity: 1, locked: false,
};

/** Prompt requests forwarded to the panel (which owns the value modal),
 * together with a reply seam back into the controller: a positive number
 * confirms, 0 means "skip this axis", null cancels. */
export type VisualToolPrompt =
  | { kind: "calibrate"; spanPx: number }
  | { kind: "resizeAxis"; axis: "x" | "y"; spanPx: number };

export function VisualCanvas(props: {
  copper?: CopperEditor;
  copperFrame?: number;
  components?: ReturnType<typeof createComponentEditor>;
  store: PlacementStore;
  selected: string | null;
  select: (id: string | null) => void;
  active: boolean;
  opacityDraft: { id: string; value: number } | null;
  /** Active visual tool owned by the panel; null = idle. */
  tool: VisualToolId | null;
  /** View-only whole-canvas mirrors (never written to the document). */
  cancelGeneration?: number;
  flipX: boolean;
  flipY: boolean;
  /** Panel callback: the controller went idle after Esc/a commit, so the
   * toolbar button unpresses. */
  onToolEnd: () => void;
  /** Panel callback: open the value modal for a prompt intent. */
  onPrompt: (
    prompt: VisualToolPrompt,
    reply: (value: number | null) => void,
  ) => void;
}) {
  let canvas!: HTMLCanvasElement;
  let host!: HTMLDivElement;
  const controller = createVisualToolController();
  const cache = new Map<string, ImageBitmap>();
  const pending = new Set<string>();
  const failed = new Set<string>();
  let disposed = false,
    frame = 0;
  let width = 1,
    height = 1;
  let scale = 1,
    offsetX = 30,
    offsetY = 30;
  let drag: {
    startWorld: Point;
    originX: number;
    originY: number;
    currentX: number;
    currentY: number;
    imageId?: string;
  } | null = null;
  const selectedImages = new Set<string>();
  const selectedComponents = new Set<string>();
  const selectedCopper = new Set<string>();
  let boxSelect: {
    startWorld: Point;
    currentWorld: Point;
    startScreen: Point;
  } | null = null;
  let multiDrag: {
    startWorld: Point;
    currentWorld: Point;
  } | null = null;
  let capturedPointer: number | undefined;
  let identity = "";
  const [loadError, setLoadError] = createSignal("");
  const [retry, setRetry] = createSignal(0);
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const images = () =>
    (props.store.visual.activePcb()?.images ?? []).filter(
      (image) =>
        !props.copper ||
        !image.layerId ||
        image.layerId === props.copper.layer(),
    );
  const redraw = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(draw);
  };
  const opacity = (image: VisualImage) =>
    props.opacityDraft?.id === image.id
      ? props.opacityDraft.value
      : image.opacity;
  /** Drag-draft positions ride along through the transform seam so previews,
   * outlines and hit tests track the gesture, not the committed record. */
  const displayed = (image: VisualImage): VisualImage => {
    if (multiDrag && selectedImages.has(image.id) && !image.locked) {
      const dx = multiDrag.currentWorld.x - multiDrag.startWorld.x;
      const dy = multiDrag.currentWorld.y - multiDrag.startWorld.y;
      return { ...image, x: image.x + dx, y: image.y + dy };
    }
    if (drag?.imageId === image.id)
      return { ...image, x: drag.currentX, y: drag.currentY };
    return image;
  };
  const view = (): OverlayView => ({
    scale,
    offsetX,
    offsetY,
    flipX: props.flipX,
    flipY: props.flipY,
    width,
    height,
  });
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 4000);
  };
  // transform.ts seams: hit tests and fit bounds run through the pure pipeline
  // (transform-aware crop containment and the union world AABB).
  const toSource = (image: VisualImage, x: number, y: number): Point =>
    worldToSource(displayed(image), { x, y });
  const visibleCopper = () => {
    const pcb = props.store.visual.activePcb();
    const layer = props.copper?.layer();
    return {
      traces: (pcb?.traces ?? []).filter(
        (trace) => !layer || trace.layerId === layer,
      ),
      zones: (pcb?.zones ?? []).filter(
        (zone) => !layer || zone.layerId === layer,
      ),
      vias: pcb?.vias ?? [],
    };
  };
  const hasVisibleCopper = () => {
    const copper = visibleCopper();
    return copper.traces.length + copper.zones.length + copper.vias.length > 0;
  };
  const sceneAabb = (list: VisualImage[]) => {
    const boxes = list.length ? [worldAabb(list)] : [];
    const copper = visibleCopper();
    for (const trace of copper.traces) {
      for (const p of trace.points)
        boxes.push({
          left: p.x - trace.width / 2,
          right: p.x + trace.width / 2,
          top: p.y - trace.width / 2,
          bottom: p.y + trace.width / 2,
        });
    }
    for (const zone of copper.zones) {
      for (const p of zone.points)
        boxes.push({ left: p.x, right: p.x, top: p.y, bottom: p.y });
    }
    for (const via of copper.vias)
      boxes.push({
        left: via.x - via.diameter / 2,
        right: via.x + via.diameter / 2,
        top: via.y - via.diameter / 2,
        bottom: via.y + via.diameter / 2,
      });
    if (!boxes.length) return null;
    return boxes.reduce((box, next) => ({
      left: Math.min(box.left, next.left),
      right: Math.max(box.right, next.right),
      top: Math.min(box.top, next.top),
      bottom: Math.max(box.bottom, next.bottom),
    }));
  };
  const reply = (value: number | null) =>
    execute(controller.modalResult(value));
  /** Executes controller intents: document commits go through the store
   * (one mutate per commit), toasts stay local, prompts forward to the panel.
   * When the controller ends up idle while a tool is still requested (Esc,
   * commit-and-exit, or a rejected begin), the toolbar button unpresses. */
  const execute = (intents: ToolIntent[]) => {
    for (const intent of intents) {
      switch (intent.kind) {
        case "commitRotation":
          props.store.visual.updateImageTransform(intent.imageId, intent.patch);
          break;
        case "commitCrop":
          props.store.visual.updateImageTransform(intent.imageId, intent.patch);
          break;
        case "commitAlign":
          props.store.visual.updateImageTransform(intent.imageId, intent.patch);
          break;
        case "commitResize":
          props.store.visual.updateImageTransform(intent.imageId, {
            warp: intent.warp,
          });
          break;
        case "commitDeskew":
          props.store.visual.updateImageTransform(intent.imageId, {
            perspective: intent.perspective,
          });
          break;
        case "commitCalibrate":
          props.store.visual.calibratePcb(intent.pxPerMm);
          break;
        case "toast":
          showToast(intent.message);
          break;
        case "promptCalibrate":
          props.onPrompt({ kind: "calibrate", spanPx: intent.spanPx }, reply);
          break;
        case "promptResizeAxis":
          props.onPrompt(
            { kind: "resizeAxis", axis: intent.axis, spanPx: intent.spanPx },
            reply,
          );
          break;
      }
    }
    if (props.tool && !controller.tool()) props.onToolEnd();
    redraw();
  };
  const commitMultiMove = (dx: number, dy: number) => {
    const pcb = props.store.visual.activePcb();
    if (!pcb) return;
    const next = structuredClone(pcb) as VisualPcb;

    // 1. Unlocked images
    for (const img of next.images ?? []) {
      if (selectedImages.has(img.id) && !img.locked) {
        img.x += dx;
        img.y += dy;
      }
    }

    // 2. Unlocked components
    for (const c of next.components ?? []) {
      if (selectedComponents.has(c.id) && !c.locked) {
        const before = structuredClone(c);
        c.x += dx;
        c.y += dy;
        for (const t of next.traces ?? []) {
          for (const [key, index] of [
            ["startPad", 0],
            ["endPad", t.points.length - 1],
          ] as const) {
            const anchor = t[key];
            if (anchor?.componentId !== before.id) continue;
            if (!selectedCopper.has(t.id)) {
              const pad = c.definition.footprint.pads.find(
                (p) => p.number === anchor.terminal,
              );
              if (pad) t.points[index] = padPoint(c, pad, next.pxPerMm ?? 1);
              else delete t[key];
            }
          }
        }
      }
    }

    // 3. Unlocked copper traces
    for (const t of next.traces ?? []) {
      if (selectedCopper.has(t.id) && !t.locked) {
        for (const p of t.points) {
          p.x += dx;
          p.y += dy;
        }
      }
    }

    // 4. Unlocked copper vias
    for (const v of next.vias ?? []) {
      if (selectedCopper.has(v.id) && !v.locked) {
        v.x += dx;
        v.y += dy;
      }
    }

    // 5. Unlocked copper zones
    for (const z of next.zones ?? []) {
      if (selectedCopper.has(z.id) && !z.locked) {
        for (const p of z.points) {
          p.x += dx;
          p.y += dy;
        }
      }
    }

    // Multi-selection moves commit through the same reconciliation pipeline
    // as single-element edits: stale pad anchors are dropped, new NC contacts
    // ask, and distinct nets joined by the new geometry open the merge dialog
    // instead of silently shorting. Raw replacePcb would skip all of it.
    const movedCopper = [
      ...(next.traces ?? []),
      ...(next.vias ?? []),
      ...(next.zones ?? []),
    ].filter((e) => selectedCopper.has(e.id) && !e.locked);
    const movedComponents = (next.components ?? []).filter(
      (c) => selectedComponents.has(c.id) && !c.locked,
    );
    if (props.copper && (movedCopper.length || movedComponents.length)) {
      props.copper.commitMoved(
        next,
        [
          ...movedCopper.map((e) => e.id),
          ...movedComponents.flatMap((c) =>
            c.terminals.map((t) => c.id + ":" + t.number),
          ),
        ],
      );
      return;
    }
    props.store.visual.replacePcb(next);
  };
  const deleteMultiSelection = () => {
    const pcb = props.store.visual.activePcb();
    if (!pcb) return;
    const next = structuredClone(pcb) as VisualPcb;
    const removedComponents = (next.components ?? [])
      .filter((c) => selectedComponents.has(c.id) && !c.locked)
      .map((c) => c.id);
    if (selectedImages.size > 0) {
      next.images = (next.images ?? []).filter(
        (img) => !selectedImages.has(img.id) || img.locked,
      );
    }
    if (selectedComponents.size > 0) {
      next.components = (next.components ?? []).filter(
        (c) => !selectedComponents.has(c.id) || c.locked,
      );
    }
    if (selectedCopper.size > 0) {
      next.traces = (next.traces ?? []).filter(
        (t) => !selectedCopper.has(t.id) || t.locked,
      );
      next.vias = (next.vias ?? []).filter(
        (v) => !selectedCopper.has(v.id) || v.locked,
      );
      next.zones = (next.zones ?? []).filter(
        (z) => !selectedCopper.has(z.id) || z.locked,
      );
    }
    // Delete the removed components' trace pad anchors and schematic
    // units/labels/wires so the document stays exportable; without this a
    // multi-delete strands "Schematic references a missing component."
    pruneComponentReferences(next, removedComponents);
    selectedImages.clear();
    selectedComponents.clear();
    selectedCopper.clear();
    props.select(null);
    props.components?.setSelected("");
    props.copper?.setSelected(null);
    props.store.visual.replacePcb(next);
    redraw();
  };
  /** Perspective render path: the straightened photo is approximated by an
   * affine per mesh triangle. Each triangle clips in WORLD space first (a
   * clip is captured in device space, so the path must be built while the
   * world transform is still active), is inflated radially by
   * SEAM_OVERDRAW_PX / scale to hide seams, and only then applies the
   * triangle's source→world affine and draws the full bitmap. */
  const drawPerspectiveImage = (
    ctx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    shown: VisualImage,
  ) => {
    for (const tri of perspectiveMesh(shown)) {
      const A = affineFromTriangle(tri.src, tri.world);
      if (!A) continue;
      const [p0, p1, p2] = tri.world;
      const cx = (p0.x + p1.x + p2.x) / 3;
      const cy = (p0.y + p1.y + p2.y) / 3;
      const overdraw = SEAM_OVERDRAW_PX / Math.max(scale, 1e-6);
      const push = (p: Point): Point => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const len = Math.hypot(dx, dy) || 1;
        const k = (len + overdraw) / len;
        return { x: cx + dx * k, y: cy + dy * k };
      };
      const a = push(p0);
      const b = push(p1);
      const c = push(p2);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.clip();
      ctx.transform(A.a, A.b, A.c, A.d, A.e, A.f);
      ctx.drawImage(bitmap, 0, 0);
      ctx.restore();
    }
  };
  function draw() {
    frame = 0;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    // Clear the whole backing store, not the CSS box: once sizes come from
    // devicePixelContentBoxSize the bitmap can exceed css × dpr by a device
    // pixel, and a CSS-sized clear would leave a stale edge.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    // View flips mirror the whole world pass about the canvas center; the
    // overlay pass below draws in screen space through worldToScreen instead.
    if (props.flipX) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    if (props.flipY) {
      ctx.translate(0, height);
      ctx.scale(1, -1);
    }
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    for (const image of images()) {
      if (!image.visible || opacity(image) === 0) continue;
      const bitmap = cache.get(image.assetHash);
      if (!bitmap) continue;
      const shown = displayed(image);
      ctx.save();
      ctx.globalAlpha = opacity(image);
      if (shown.perspective) {
        // Deskewed: per-triangle affine mesh over the crop rect.
        drawPerspectiveImage(ctx, bitmap, shown);
      } else {
        const anchor = imageAnchor(shown);
        const linear = imageLinear(shown);
        const crop = effectiveVisualTransform(shown).crop;
        ctx.translate(anchor.x, anchor.y);
        ctx.transform(linear.a, linear.b, linear.c, linear.d, 0, 0);
        ctx.drawImage(
          bitmap,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          -crop.w / 2,
          -crop.h / 2,
          crop.w,
          crop.h,
        );
      }
      ctx.restore();
      if (props.selected === image.id || selectedImages.has(image.id)) {
        const footprint = worldFootprint(shown);
        ctx.strokeStyle = "#ffcd11";
        ctx.lineWidth = 1.5 / scale;
        ctx.beginPath();
        ctx.moveTo(footprint[0].x, footprint[0].y);
        for (const corner of footprint.slice(1)) ctx.lineTo(corner.x, corner.y);
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.save();
    if (props.flipX) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    if (props.flipY) {
      ctx.translate(0, height);
      ctx.scale(1, -1);
    }
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    const multiOffset = multiDrag
      ? {
          ids: new Set([...selectedComponents, ...selectedCopper]),
          dx: multiDrag.currentWorld.x - multiDrag.startWorld.x,
          dy: multiDrag.currentWorld.y - multiDrag.startWorld.y,
        }
      : undefined;
    props.components?.draw(ctx, scale, multiOffset, selectedComponents);
    props.copper?.draw(ctx, scale, multiOffset, selectedCopper);
    if (boxSelect) {
      const minX = Math.min(boxSelect.startWorld.x, boxSelect.currentWorld.x);
      const maxX = Math.max(boxSelect.startWorld.x, boxSelect.currentWorld.x);
      const minY = Math.min(boxSelect.startWorld.y, boxSelect.currentWorld.y);
      const maxY = Math.max(boxSelect.startWorld.y, boxSelect.currentWorld.y);
      ctx.save();
      ctx.fillStyle = "rgba(255, 205, 17, 0.12)";
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
      ctx.strokeStyle = "rgba(255, 205, 17, 0.85)";
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([4 / scale, 4 / scale]);
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      ctx.restore();
    }
    ctx.restore();
    // Screen-space overlays run after the scene so the loupe self-copy reads
    // fully painted pixels.
    controller.update(view());
    drawVisualOverlays(ctx, controller.overlay(), view());
  }
  function fit() {
    const shown = images().filter(
      (image) => image.visible && opacity(image) > 0,
    );
    const box = sceneAabb(shown);
    if (!box) {
      scale = 1;
      offsetX = offsetY = 30;
      redraw();
      return;
    }
    const next = Math.max(
      0.001,
      Math.min(
        100,
        Math.min(
          Math.max(1, width - 40) / Math.max(1, box.right - box.left),
          Math.max(1, height - 40) / Math.max(1, box.bottom - box.top),
        ),
      ),
    );
    scale = next;
    offsetX = (width - (box.right - box.left) * scale) / 2 - box.left * scale;
    offsetY = (height - (box.bottom - box.top) * scale) / 2 - box.top * scale;
    redraw();
  }
  createEffect(() => {
    const nextIdentity = `${props.store.projectSession()}:${props.store.visual.activePcb()?.id}`;
    if (identity !== nextIdentity) {
      identity = nextIdentity;
      drag = null;
      boxSelect = null;
      multiDrag = null;
      selectedImages.clear();
      selectedComponents.clear();
      selectedCopper.clear();
      scale = 1;
      offsetX = offsetY = 30;
      failed.clear();
      setLoadError("");
      setToast(null);
    }
    const current = images();
    if (props.selected) {
      selectedImages.clear();
      selectedImages.add(props.selected);
    }
    void props.selected;
    void props.opacityDraft;
    void props.copperFrame;
    void props.store.visual.activePcb();
    retry();
    if (!props.active) {
      drag = null;
      boxSelect = null;
      multiDrag = null;
    }
    const hashes = new Set(current.map((image) => image.assetHash));
    for (const [hash, bitmap] of cache)
      if (!hashes.has(hash)) {
        bitmap.close();
        cache.delete(hash);
      }
    for (const hash of hashes)
      if (!cache.has(hash) && !pending.has(hash) && !failed.has(hash)) {
        pending.add(hash);
        void assetRead(hash)
          .then((bytes) => createImageBitmap(new Blob([bytes])))
          .then((bitmap) => {
            if (disposed || !images().some((image) => image.assetHash === hash))
              bitmap.close();
            else {
              cache.set(hash, bitmap);
              if (images().length === 1) fit();
              redraw();
            }
          })
          .catch(() => {
            failed.add(hash);
            setLoadError("Some photographs could not be loaded.");
          })
          .finally(() => {
            pending.delete(hash);
          });
      }
    redraw();
  });
  // Tool activation: the panel owns the signal, the canvas owns the
  // controller. begin() captures the target image at activation; re-selecting
  // another tool re-begins (the controller replaces its own prior state).
  createEffect(() => {
    const tool = props.tool;
    const running = controller.tool();
    if (tool && running !== tool) {
      // Measure needs no photograph selection: it falls back to the first
      // image and finally a placeholder (plain canvas-px geometry).
      const image =
        images().find((entry) => entry.id === props.selected) ??
        (tool === "measure" ? (images()[0] ?? MEASURE_PLACEHOLDER) : undefined);
      if (!image) {
        if (running) execute(controller.cancel());
        props.onToolEnd();
        return;
      }
      execute(
        controller.begin(tool, image, props.store.visual.activePcb()?.pxPerMm),
      );
      controller.update(view());
      redraw();
    } else if (!tool && running) {
      execute(controller.cancel());
    }
  });
  // The captured target image disappeared (deleted/undone): cancel the tool.
  createEffect(() => {
    const list = images();
    const target = controller.targetId();
    if (target && !list.some((image) => image.id === target))
      execute(controller.cancel());
  });
  createEffect(() => {
    void props.flipX;
    void props.flipY;
    controller.update(view());
    redraw();
  });
  createEffect(() => {
    if (canvas) canvas.style.cursor = props.tool ? "crosshair" : "";
  });
  createEffect(on(() => props.cancelGeneration, () => {
    drag = null;
    execute(controller.cancel());
    if (capturedPointer !== undefined && canvas?.hasPointerCapture?.(capturedPointer)) canvas.releasePointerCapture?.(capturedPointer);
    capturedPointer = undefined;
    redraw();
  }, { defer: true }));
  createEffect(on(() => props.components?.placementGeneration(), generation => {
    if (!generation || !props.components?.placementActive()) return;
    props.components.move(screenToWorld(view(), { x: width / 2, y: height / 2 }));
    redraw();
    queueMicrotask(() => { if (props.active && props.components?.placementActive()) canvas?.focus(); });
  }));
  onMount(() => {
    const resize = (entries?: ResizeObserverEntry[]) => {
      // Fractional CSS size: clientWidth would floor away subpixels that the
      // view/fit math still wants to see.
      const rect = host.getBoundingClientRect();
      const nextWidth = Math.max(1, rect.width),
        nextHeight = Math.max(1, rect.height);
      const ratio = window.devicePixelRatio || 1;
      // Prefer the observer's device-pixel box (already snapped, no
      // fractional drift); the direct on-mount call has no entries and
      // derives it instead. The array can be empty per spec, hence the guard.
      const box = entries?.[0]?.devicePixelContentBoxSize;
      const w = box?.length ? box[0].inlineSize : Math.round(nextWidth * ratio);
      const h = box?.length ? box[0].blockSize : Math.round(nextHeight * ratio);
      // Assigning canvas.width/height clears the bitmap even when the value is
      // unchanged, so an unchanged tick skips the assignment AND the draw
      // below (no-op resizes must not blank the canvas).
      if (
        width === nextWidth &&
        height === nextHeight &&
        canvas.width === w &&
        canvas.height === h
      )
        return;
      width = nextWidth;
      height = nextHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      // ResizeObserver fires after layout but BEFORE paint; deferring this
      // draw to rAF composites a blank frame on every resize tick (the
      // sidebar-resize flicker), so draw synchronously and drop any pending
      // frame it would have painted.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      draw();
    };
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(host);
    resize();
    onCleanup(() => observer?.disconnect());
  });
  onCleanup(() => {
    disposed = true;
    cancelAnimationFrame(frame);
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    for (const bitmap of cache.values()) bitmap.close();
  });
  const canvasPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const end = (commit: boolean) => {
    if (commit && drag?.imageId)
      props.store.visual.updateImage(drag.imageId, {
        x: drag.currentX,
        y: drag.currentY,
      });
    drag = null;
    redraw();
  };
  return (
    <div class="ve-canvas" ref={host}>
      <Show when={props.components?.placementActive()}><div role="status" style={{ position: "absolute", top: "12px", left: "12px", "pointer-events": "none", "z-index": 1, background: "var(--bg)", padding: "6px 10px", border: "1px solid var(--border)" }}>Click to place | R rotate | Esc cancel</div></Show>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="Visual editor photographs"
        onContextMenu={(e) => e.preventDefault()}
        onDblClick={() => {
          if (!props.tool) props.copper?.finish();
        }}
        onWheel={(e) => {
          e.preventDefault();
          // Convert the cursor to world space with the CURRENT mapping (flips
          // included) first, then solve the offsets so that world point stays
          // under the cursor at the new scale.
          const screen = canvasPoint(e);
          const world = screenToWorld(view(), screen);
          const next = Math.max(
            0.001,
            Math.min(100, scale * Math.exp(-e.deltaY * 0.001)),
          );
          const base = screenToBase(view(), screen);
          offsetX = base.x - world.x * next;
          offsetY = base.y - world.y * next;
          scale = next;
          controller.update(view());
          redraw();
        }}
        onPointerDown={(e) => {
          if (!props.active || ![0, 1, 2].includes(e.button)) return;
          e.preventDefault();
          canvas.focus();
          capturedPointer = e.pointerId;
          canvas.setPointerCapture?.(e.pointerId);
          const screen = canvasPoint(e);
          const world = screenToWorld(view(), screen);
          // A right click closes a pending copper outline before the legacy
          // right-drag pan takes ownership of this pointer.
          if (
            !controller.tool() &&
            e.button === 2 &&
            props.copper?.down(world, scale, e.shiftKey, e.button)
          ) {
            redraw();
            return;
          }
          // Pan entry points: middle button under any tool; without a tool also
          // right-drag and Alt-drag (legacy behavior). Tool gestures use button 0.
          if (
            e.button === 1 ||
            (!controller.tool() && (e.button === 2 || e.altKey))
          ) {
            drag = {
              startWorld: world,
              originX: offsetX,
              originY: offsetY,
              currentX: offsetX,
              currentY: offsetY,
            };
            return;
          }
          if (controller.tool()) {
            // AC26: tool gestures never select or move images
            if (e.button !== 0) return; // right button does nothing mid-tool
            controller.update(view());
            execute(
              controller.pointer({
                phase: "down",
                world,
                screen,
                shift: e.shiftKey,
              }),
            );
            return;
          }
          if (e.button === 0 && props.components?.placementActive()) {
            props.components.down(world);
            redraw();
            return;
          }
          if (props.copper?.drawing()) {
            props.copper.down(world, scale, e.shiftKey, e.button);
            redraw();
            return;
          }

          const hitCopper = props.copper?.hit(world, scale);
          const hitComponent = hitCopper ? undefined : props.components?.hit(world);
          const hitImg = hitVisualImage(
            images(),
            world.x,
            world.y,
            opacity,
            toSource,
          );

          const totalSelected =
            selectedComponents.size + selectedCopper.size + selectedImages.size;
          const isHitSelected = hitCopper ? selectedCopper.has(hitCopper.id)
            : hitComponent ? selectedComponents.has(hitComponent.id)
            : hitImg && !hitImg.locked && selectedImages.has(hitImg.id);

          if (isHitSelected && totalSelected > 0 && !(hitCopper && "points" in hitCopper && "width" in hitCopper && hitCopper.points.some(q => Math.hypot(world.x-q.x, world.y-q.y) < 8 / scale))) {
            multiDrag = {
              startWorld: world,
              currentWorld: world,
            };
            redraw();
            return;
          }

          if (hitComponent) {
            if (!e.shiftKey) {
              selectedComponents.clear();
              selectedCopper.clear();
              selectedImages.clear();
              props.copper?.setSelected(null);
              props.select(null);
            }
            selectedComponents.add(hitComponent.id);
            props.components?.setSelected(hitComponent.id);
            if (!hitComponent.locked) {
              multiDrag = {
                startWorld: world,
                currentWorld: world,
              };
            }
            redraw();
            return;
          }

          if (hitCopper) {
            if (!e.shiftKey) {
              selectedComponents.clear();
              selectedCopper.clear();
              selectedImages.clear();
              props.components?.setSelected("");
              props.select(null);
            }
            selectedCopper.add(hitCopper.id);
            props.copper?.setSelected(hitCopper.id);
            const vertex =
              "points" in hitCopper
                ? hitCopper.points.findIndex(
                    (q) => Math.hypot(world.x - q.x, world.y - q.y) < 8 / scale,
                  )
                : -1;
            if (vertex >= 0) {
              props.copper?.down(world, scale, e.shiftKey, e.button);
            } else if (!hitCopper.locked) {
              multiDrag = {
                startWorld: world,
                currentWorld: world,
              };
            }
            redraw();
            return;
          }

          if (hitImg && !hitImg.locked) {
            if (!e.shiftKey) {
              selectedComponents.clear();
              selectedCopper.clear();
              selectedImages.clear();
              props.components?.setSelected("");
              props.copper?.setSelected(null);
            }
            selectedImages.add(hitImg.id);
            props.select(hitImg.id);
            multiDrag = {
              startWorld: world,
              currentWorld: world,
            };
            redraw();
            return;
          }

          // Empty space or locked image: start box selection!
          if (!e.shiftKey) {
            selectedComponents.clear();
            selectedCopper.clear();
            selectedImages.clear();
            props.components?.setSelected("");
            props.copper?.setSelected(null);
            props.select(hitImg?.locked ? hitImg.id : null);
          }
          boxSelect = {
            startWorld: world,
            currentWorld: world,
            startScreen: screen,
          };
          redraw();
        }}
        onPointerMove={(e) => {
          const screen = canvasPoint(e);
          const world = screenToWorld(view(), screen);
          if (!controller.tool()) {
            props.components?.move(world);
            props.copper?.move(world, scale, e.shiftKey);
          }
          // An active pan (middle button) outranks the tool: it never started a gesture.
          if (drag && !drag.imageId) {
            // pan: keep the grabbed world point under the cursor
            const base = screenToBase(view(), screen);
            offsetX = base.x - drag.startWorld.x * scale;
            offsetY = base.y - drag.startWorld.y * scale;
            drag.currentX = offsetX;
            drag.currentY = offsetY;
            controller.update(view());
            redraw();
            return;
          }
          if (boxSelect) {
            boxSelect.currentWorld = world;
            redraw();
            return;
          }
          if (multiDrag) {
            multiDrag.currentWorld = world;
            redraw();
            return;
          }
          if (controller.tool()) {
            controller.update(view());
            if (e.buttons === 0) controller.hover(world);
            else
              execute(
                controller.pointer({
                  phase: "move",
                  world,
                  screen,
                  shift: e.shiftKey,
                }),
              );
            redraw();
            return;
          }
          if (!drag) return;
          if (drag.imageId) {
            // translation is outermost: world deltas track 1:1
            drag.currentX = drag.originX + world.x - drag.startWorld.x;
            drag.currentY = drag.originY + world.y - drag.startWorld.y;
          }
          redraw();
        }}
        onPointerUp={(e) => {
          const screen = canvasPoint(e);
          const world = screenToWorld(view(), screen);
          if (!controller.tool()) {
            props.components?.up(world);
            props.copper?.up(world, scale, e.shiftKey);
          }
          if (drag && !drag.imageId) {
            // finish a mid-tool pan
            end(true);
            if (canvas.hasPointerCapture?.(e.pointerId))
              canvas.releasePointerCapture?.(e.pointerId);
            return;
          }
          if (boxSelect) {
            const dist = Math.hypot(
              screen.x - boxSelect.startScreen.x,
              screen.y - boxSelect.startScreen.y,
            );
            if (dist >= 4) {
              const minX = Math.min(
                boxSelect.startWorld.x,
                boxSelect.currentWorld.x,
              );
              const maxX = Math.max(
                boxSelect.startWorld.x,
                boxSelect.currentWorld.x,
              );
              const minY = Math.min(
                boxSelect.startWorld.y,
                boxSelect.currentWorld.y,
              );
              const maxY = Math.max(
                boxSelect.startWorld.y,
                boxSelect.currentWorld.y,
              );

              selectedImages.clear();
              selectedComponents.clear();
              selectedCopper.clear();

              const pcb = props.store.visual.activePcb();
              const layer = props.copper?.layer();

              // 1. Images (exclude locked images!)
              for (const img of images()) {
                if (img.locked) continue;
                const fp = worldFootprint(displayed(img));
                const xs = fp.map((p) => p.x);
                const ys = fp.map((p) => p.y);
                const imgMinX = Math.min(...xs),
                  imgMaxX = Math.max(...xs);
                const imgMinY = Math.min(...ys),
                  imgMaxY = Math.max(...ys);
                if (
                  imgMinX <= maxX &&
                  imgMaxX >= minX &&
                  imgMinY <= maxY &&
                  imgMaxY >= minY
                ) {
                  selectedImages.add(img.id);
                }
              }

              // 2. Components
              for (const c of pcb?.components ?? []) {
                if (
                  !layer ||
                  c.layerId === layer ||
                  c.definition.footprint.pads.some((p) => p.plated && p.drill)
                ) {
                  if (
                    c.x >= minX &&
                    c.x <= maxX &&
                    c.y >= minY &&
                    c.y <= maxY
                  ) {
                    selectedComponents.add(c.id);
                  } else {
                    const b = footprintBounds(c.definition.footprint);
                    if (b) {
                      const px = pcb?.pxPerMm ?? 1;
                      const cMinX = c.x + b.minX * px;
                      const cMaxX = c.x + b.maxX * px;
                      const cMinY = c.y + b.minY * px;
                      const cMaxY = c.y + b.maxY * px;
                      if (
                        cMinX <= maxX &&
                        cMaxX >= minX &&
                        cMinY <= maxY &&
                        cMaxY >= minY
                      ) {
                        selectedComponents.add(c.id);
                      }
                    }
                  }
                }
              }

              // 3. Copper traces
              for (const t of pcb?.traces ?? []) {
                if (!layer || t.layerId === layer) {
                  const xs = t.points.map((p) => p.x);
                  const ys = t.points.map((p) => p.y);
                  const tMinX = Math.min(...xs),
                    tMaxX = Math.max(...xs);
                  const tMinY = Math.min(...ys),
                    tMaxY = Math.max(...ys);
                  if (
                    tMinX <= maxX &&
                    tMaxX >= minX &&
                    tMinY <= maxY &&
                    tMaxY >= minY
                  ) {
                    selectedCopper.add(t.id);
                  }
                }
              }

              // 4. Copper vias
              for (const v of pcb?.vias ?? []) {
                const r = (v.diameter || 0) / 2;
                if (
                  v.x + r >= minX &&
                  v.x - r <= maxX &&
                  v.y + r >= minY &&
                  v.y - r <= maxY
                ) {
                  selectedCopper.add(v.id);
                }
              }

              // 5. Copper zones
              for (const z of pcb?.zones ?? []) {
                if (!layer || z.layerId === layer) {
                  const xs = z.points.map((p) => p.x);
                  const ys = z.points.map((p) => p.y);
                  const zMinX = Math.min(...xs),
                    zMaxX = Math.max(...xs);
                  const zMinY = Math.min(...ys),
                    zMaxY = Math.max(...ys);
                  if (
                    zMinX <= maxX &&
                    zMaxX >= minX &&
                    zMinY <= maxY &&
                    zMaxY >= minY
                  ) {
                    selectedCopper.add(z.id);
                  }
                }
              }

              if (selectedImages.size === 1) {
                props.select(selectedImages.values().next().value ?? null);
              } else {
                props.select(null);
              }
              if (selectedComponents.size === 1) {
                props.components?.setSelected(
                  selectedComponents.values().next().value ?? "",
                );
              } else {
                props.components?.setSelected("");
              }
              if (selectedCopper.size === 1) {
                props.copper?.setSelected(
                  selectedCopper.values().next().value ?? null,
                );
              } else {
                props.copper?.setSelected(null);
              }
            }
            boxSelect = null;
            redraw();
            if (canvas.hasPointerCapture?.(e.pointerId))
              canvas.releasePointerCapture?.(e.pointerId);
            return;
          }
          if (multiDrag) {
            const dx = multiDrag.currentWorld.x - multiDrag.startWorld.x;
            const dy = multiDrag.currentWorld.y - multiDrag.startWorld.y;
            if (Math.hypot(dx, dy) > 1e-4) {
              commitMultiMove(dx, dy);
            }
            multiDrag = null;
            redraw();
            if (canvas.hasPointerCapture?.(e.pointerId))
              canvas.releasePointerCapture?.(e.pointerId);
            return;
          }
          if (controller.tool()) {
            const screen = canvasPoint(e);
            controller.update(view());
            execute(
              controller.pointer({
                phase: "up",
                world: screenToWorld(view(), screen),
                screen,
                shift: e.shiftKey,
              }),
            );
            if (canvas.hasPointerCapture?.(e.pointerId))
              canvas.releasePointerCapture?.(e.pointerId);
            return;
          }
          end(true);
          if (canvas.hasPointerCapture?.(e.pointerId))
            canvas.releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={(e) => {
          props.components?.cancelDrag();
          props.copper?.cancelDrag();
          boxSelect = null;
          multiDrag = null;
          if (drag && !drag.imageId) {
            end(false);
            return;
          } // abort a mid-tool pan
          if (controller.tool()) {
            // no cancel gesture in the contract: end it
            const screen = canvasPoint(e);
            controller.update(view());
            execute(
              controller.pointer({
                phase: "up",
                world: screenToWorld(view(), screen),
                screen,
                shift: false,
              }),
            );
            return;
          }
          end(false);
        }}
        onLostPointerCapture={() => {
          props.components?.cancelDrag();
          props.copper?.cancelDrag();
          boxSelect = null;
          multiDrag = null;
          if (!controller.tool() || (drag && !drag.imageId)) end(false);
        }}
        onKeyDown={(e) => {
          if (!controller.tool() && props.components?.key(e.key)) {
            e.preventDefault();
            redraw();
            return;
          }
          if (!controller.tool() && props.copper?.key(e.key)) {
            e.preventDefault();
            redraw();
            return;
          }
          // Active-tool keys (deskew: ENTER applies). Escape deliberately
          // returns [] so the existing cancel branch below stays the single
          // exit path for every tool.
          if (controller.tool()) {
            const intents = controller.key(e.key);
            if (intents.length) {
              e.preventDefault();
              execute(intents);
              redraw();
              return;
            }
          }
          if (e.key === "Escape") {
            if (controller.tool()) {
              e.preventDefault();
              execute(controller.cancel());
              return;
            }
            end(false);
            boxSelect = null;
            multiDrag = null;
            selectedImages.clear();
            selectedComponents.clear();
            selectedCopper.clear();
            props.select(null);
            props.components?.setSelected("");
            props.copper?.setSelected(null);
            redraw();
          }
          if (e.key === "Delete") {
            if (
              selectedImages.size +
                selectedComponents.size +
                selectedCopper.size >
              0
            ) {
              e.preventDefault();
              deleteMultiSelection();
              return;
            }
          }
          if (e.key === "0") fit();
          if (e.key === "1") {
            scale = 1;
            redraw();
          }
          if (controller.tool()) return; // arrow nudging yields to the tool
          const delta = (
            {
              ArrowLeft: [-1, 0],
              ArrowRight: [1, 0],
              ArrowUp: [0, -1],
              ArrowDown: [0, 1],
            } as Record<string, number[]>
          )[e.key];
          const image = images().find((i) => i.id === props.selected);
          if (delta && image) {
            e.preventDefault();
            props.store.visual.updateImage(image.id, {
              x: image.x + delta[0] * (e.shiftKey ? 10 : 1),
              y: image.y + delta[1] * (e.shiftKey ? 10 : 1),
            });
          }
        }}
      />
      <div class="ve-view-controls">
        <button onClick={fit}>Fit</button>
        <button
          onClick={() => {
            scale = 1;
            redraw();
          }}
        >
          100%
        </button>
      </div>
      {toast() && (
        <div class="ve-toast" role="status" aria-live="polite">
          {toast()}
        </div>
      )}
      {loadError() && (
        <div class="ve-load-error" role="alert">
          {loadError()}{" "}
          <button
            onClick={() => {
              failed.clear();
              setLoadError("");
              setRetry(retry() + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!images().some((image) => image.visible && opacity(image) > 0) &&
        !props.components?.placementActive() && !hasVisibleCopper() && (
          <div class="ve-canvas-empty">
            Add photographs to compare PCB layers.
          </div>
        )}
    </div>
  );
}
