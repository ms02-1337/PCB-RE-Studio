import { Switch, Match } from "solid-js";

/** Small monochrome action glyph; the adjacent button text supplies its name. */
export function ActionIcon(props: { name: string }) {
  return <svg class="action-icon" viewBox="0 0 20 20" aria-hidden="true">
    <Switch fallback={<path d="M4 5h12v11H4zM7 2v6M13 2v6M7 11h6" />}>
      {/* Copper placement tools (icon-only toolbar buttons). */}
      <Match when={/^select tool$/i.test(props.name)}><path d="M4 3l5.6 14 2.2-6.2 6.2-2.2z" /></Match>
      <Match when={/^place trace$/i.test(props.name)}><path d="M4 15h4.5l3-8H16" /></Match>
      <Match when={/^place zone$/i.test(props.name)}><path d="M10 4l6 4.5-2.3 7H6.3L4 8.5z" /></Match>
      <Match when={/^place via$/i.test(props.name)}><><circle cx="10" cy="10" r="6.2" /><circle cx="10" cy="10" r="2.6" /></></Match>
      <Match when={/^place component$/i.test(props.name)}><><rect x="5.5" y="5.5" width="9" height="9" /><path d="M5.5 8.5h-2M5.5 11.5h-2M14.5 8.5h2M14.5 11.5h2M8.5 5.5v-2M11.5 5.5v-2M8.5 14.5v2M11.5 14.5v2" /></></Match>
      <Match when={/^unlock$/i.test(props.name)}><path d="M5 9h10v8H5zM8 9V6a3 3 0 0 1 6 0M10 12v2" /></Match>
      <Match when={/^view$|^hide$/i.test(props.name)}><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />{props.name === "Hide" && <path d="M3 3l14 14" />}</Match>
      <Match when={/lock/i.test(props.name)}><path d="M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0v3M10 12v2" /></Match>
      <Match when={/delete|remove|detach/i.test(props.name)}><path d="M4 5h12M7 5V3h6v2M6 5l1 12h6l1-12M9 8v6M11 8v6" /></Match>
      <Match when={/new|add|create/i.test(props.name)}><path d="M10 3v14M3 10h14" /></Match>
      <Match when={/open|browse|import/i.test(props.name)}><path d="M3 6h5l2 2h7l-2 9H3zM3 8V4h5l2 2h6" /></Match>
      <Match when={/save|apply|confirm/i.test(props.name)}><path d="M4 3h10l3 3v11H3V3zM6 3v5h7V3M6 17v-6h8v6" /></Match>
      <Match when={/export/i.test(props.name)}><path d="M10 13V2M6 6l4-4 4 4M4 11v6h12v-6" /></Match>
      <Match when={/copy|duplicate/i.test(props.name)}><path d="M7 7h10v10H7zM4 13H3V3h10v1" /></Match>
      <Match when={/close|cancel/i.test(props.name)}><path d="m5 5 10 10M15 5 5 15" /></Match>
      <Match when={/settings|types/i.test(props.name)}><path d="M3 6h14M3 14h14M7 3v6M13 11v6" /></Match>
      <Match when={/paste/i.test(props.name)}><path d="M7 4H4v13h12V4h-3M7 2h6v4H7z" /></Match>
      {/* Circular arrows: the head points left (CCW first — "CCW" also
          contains "CW") or right, like the feather rotate icons. */}
      <Match when={/ccw/i.test(props.name)}><path d="M.8 3.3v5h5M2.9 12.5a7.5 7.5 0 1 0 1.8-7.8L.8 8.3" /></Match>
      <Match when={/cw|rotate/i.test(props.name)}><path d="M19.2 3.3v5h-5M17.1 12.5a7.5 7.5 0 1 1-1.8-7.8l3.9 4.1" /></Match>
      {/* Mirrored triangle pairs: split by a vertical axis (horizontal
          mirror) or a horizontal axis (vertical mirror). */}
      <Match when={/mirror/i.test(props.name) && /vertical/i.test(props.name)}><path d="M3 10h14M6 3l4 5 4-5zM6 17l4-5 4 5z" /></Match>
      <Match when={/mirror/i.test(props.name)}><path d="M10 3v14M3 6l5 4-5 4zM17 6l-5 4 5 4z" /></Match>
    </Switch>
  </svg>;
}
