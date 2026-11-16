import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { assetRead } from "../../bridge/project";
import { ActionIcon } from "../ActionIcon";

/** Each keyed hash owns its URL; layout and metadata edits never reload it.
 * The caption edits the per-image display name (complete imageNames record
 * is passed up) and the trash button detaches; the thumbnail opens a
 * zoomable full-size viewer. */
export function ComponentPhoto(props: {
  hash: string;
  refdes: string;
  imageNames?: Record<string, string>;
  disabled: boolean;
  onNameChange: (names: Record<string, string>) => void;
  onDetach: () => void;
}) {
  const [url, setUrl] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  const [viewerOpen, setViewerOpen] = createSignal(false);
  let disposed = false;
  let generation = 0;
  const load = async () => {
    const request = ++generation;
    setFailed(false);
    try {
      const bytes = await assetRead(props.hash);
      if (disposed || request !== generation) return;
      const next = URL.createObjectURL(new Blob([bytes]));
      const old = url();
      setUrl(next);
      if (old) URL.revokeObjectURL(old);
    } catch { if (!disposed && request === generation) setFailed(true); }
  };
  onMount(() => void load());
  onCleanup(() => { disposed = true; if (url()) URL.revokeObjectURL(url()!); });

  const [nameDraft, setNameDraft] = createSignal(props.imageNames?.[props.hash] ?? "");
  // The draft follows the document so external edits re-seed the field.
  createEffect(() => setNameDraft(props.imageNames?.[props.hash] ?? ""));

  /** Commits the complete record: set the key, or delete it when the trimmed
   * draft is empty so unused keys never linger in the document. */
  const commitName = () => {
    const trimmed = nameDraft().trim();
    const current = props.imageNames ?? {};
    if (!trimmed) {
      if (!(props.hash in current)) {
        setNameDraft("");
        return;
      }
      const next = { ...current };
      delete next[props.hash];
      props.onNameChange(next);
      setNameDraft("");
      return;
    }
    if (current[props.hash] === trimmed) {
      setNameDraft(trimmed);
      return;
    }
    props.onNameChange({ ...current, [props.hash]: trimmed });
  };

  return <figure class="pl-image">
    <Show when={url()} fallback={<Show when={failed()} fallback={<span class="muted">Loading image…</span>}><span role="alert">Image could not be loaded.</span><button onClick={() => void load()}><ActionIcon name="Retry" />Retry</button></Show>}>
      <button
        class="pl-image-open"
        title="Open the image viewer"
        aria-label={`Open image for ${props.refdes}`}
        onClick={() => setViewerOpen(true)}
      >
        <img src={url()} alt={`Image for ${props.refdes}`} />
      </button>
    </Show>
    <figcaption>
      <input
        class="pl-image-name"
        aria-label="Image name"
        placeholder="Image name"
        maxLength={200}
        value={nameDraft()}
        disabled={props.disabled}
        onInput={(event) => setNameDraft(event.currentTarget.value)}
        onBlur={commitName}
        onChange={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitName();
          }
        }}
      />
      <button
        class="pl-image-remove"
        aria-label="Delete image"
        title="Remove this image"
        disabled={props.disabled}
        onClick={props.onDetach}
      ><ActionIcon name="Delete image" /></button>
    </figcaption>
    <Show when={viewerOpen() && url()}>
      <ImageViewer url={url()!} alt={`Image for ${props.refdes}`} onClose={() => setViewerOpen(false)} />
    </Show>
  </figure>;
}

/** Full-size centered viewer for one photo: wheel zoom (clamped 0.1-16,
 * anchored to the cursor), drag-pan while zoomed, Escape/backdrop/close
 * button, transform reset on every close. */
function ImageViewer(props: { url: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = createSignal(1);
  const [offset, setOffset] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let restoreFocus: HTMLElement | null = null;
  let drag: { x: number; y: number; ox: number; oy: number } | null = null;
  let closeButton: HTMLButtonElement | undefined;

  onMount(() => {
    restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton?.focus();
  });

  const close = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setDragging(false);
    drag = null;
    props.onClose();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };

  const onWheel = (event: WheelEvent & { currentTarget: HTMLElement }) => {
    event.preventDefault();
    const oldScale = scale();
    const next = Math.min(16, Math.max(0.1, oldScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (next === oldScale) return;
    // Keep the image point under the cursor fixed while zooming.
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left - rect.width / 2;
    const py = event.clientY - rect.top - rect.height / 2;
    const k = next / oldScale;
    setOffset({ x: px - (px - offset().x) * k, y: py - (py - offset().y) * k });
    setScale(next);
  };

  const onPointerDown = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (event.button !== 0 || scale() <= 1) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, ox: offset().x, oy: offset().y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y });
  };

  const endDrag = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!drag) return;
    drag = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      class="overlay overlay--center"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        class="palette image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button"),
          );
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header class="type-dialog-header">
          <h2>Image viewer</h2>
        </header>
        <div
          class="image-viewer-stage"
          data-zoomed={scale() > 1}
          data-dragging={dragging()}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            src={props.url}
            alt={props.alt}
            draggable={false}
            style={{ transform: `translate(${offset().x}px, ${offset().y}px) scale(${scale()})` }}
          />
        </div>
        <p class="muted image-viewer-hint">Scroll to zoom · drag to pan</p>
        <footer class="type-dialog-footer">
          <button
            ref={closeButton}
            type="button"
            class="type-close"
            onClick={close}
          >
            <ActionIcon name="Close" />
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
