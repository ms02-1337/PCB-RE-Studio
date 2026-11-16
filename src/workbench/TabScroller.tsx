import { createSignal, onMount, onCleanup, type JSX } from "solid-js";
import "./tabScroller.css";

/** Single-row tab overflow without a native scrollbar changing the bar height. */
export function TabScroller(props: { class: string; label: string; children: JSX.Element }) {
  let viewport!: HTMLDivElement;
  const [left, setLeft] = createSignal(false);
  const [right, setRight] = createSignal(false);
  const measure = () => {
    setLeft(viewport.scrollLeft > 1);
    setRight(viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1);
  };
  const reveal = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    if (bounds.left < view.left) viewport.scrollLeft -= view.left - bounds.left;
    else if (bounds.right > view.right) viewport.scrollLeft += bounds.right - view.right;
    measure();
  };
  const scroll = (direction: number) => {
    viewport.scrollLeft += direction * Math.max(100, viewport.clientWidth * 0.75);
    measure();
  };
  onMount(() => {
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    resize?.observe(viewport);
    window.addEventListener("resize", measure);
    const changes = new MutationObserver(() => {
      const active = viewport.querySelector<HTMLElement>('[aria-current="true"]');
      if (active) reveal(active);
      else measure();
    });
    changes.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"], characterData: true });
    measure();
    onCleanup(() => { resize?.disconnect(); changes.disconnect(); window.removeEventListener("resize", measure); });
  });
  return <div class={`${props.class} tab-scroller`} role="toolbar" aria-label={props.label}>
    <button class="tab-scroll-arrow" aria-label={`Scroll ${props.label} left`} title="Scroll tabs left" disabled={!left()} onClick={() => scroll(-1)}>‹</button>
    <div class="tab-scroll-viewport" ref={viewport} onScroll={measure} onFocusIn={event => { if (event.target instanceof HTMLElement) reveal(event.target); }}>{props.children}</div>
    <button class="tab-scroll-arrow" aria-label={`Scroll ${props.label} right`} title="Scroll tabs right" disabled={!right()} onClick={() => scroll(1)}>›</button>
  </div>;
}
