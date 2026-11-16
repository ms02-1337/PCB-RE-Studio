import { it, expect, afterEach } from "vitest";
import type { Component, ProjectDoc } from "./projectDoc";
import { normalizeMappingTabs, SEED_TYPES } from "./projectDoc";
import { assetToken, buildProjectHtml, escapeHtml } from "./htmlExport";

const BOARD_HASH = "a".repeat(64);
const PHOTO_HASH = "b".repeat(64);
const DATASHEET_HASH = "c".repeat(64);

const reportFrames: HTMLIFrameElement[] = [];
afterEach(() => { reportFrames.splice(0).forEach((frame) => frame.remove()); });

/** Execute the actual exported script against an isolated browser document. */
function liveReport(project = sampleDoc()) {
  const html = buildProjectHtml(project);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const script = parsed.querySelector("script")!.textContent!;
  parsed.querySelector("script")!.remove();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  reportFrames.push(frame);
  const doc = frame.contentDocument!;
  doc.open(); doc.write(parsed.documentElement.outerHTML); doc.close();
  const win = frame.contentWindow!;
  new Function("document", "window", "MouseEvent", script)(doc, win, MouseEvent);
  const viewport = doc.querySelector<HTMLElement>("#scene-viewport")!;
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  viewport.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 600, right: 810, bottom: 620, x: 10, y: 20, toJSON() {} });
  return doc;
}

function sceneView(doc: Document) {
  const values = doc.querySelector<HTMLElement>(".scene")!.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)!;
  return { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) };
}

function pointer(name: string, button: number, x: number, y: number, id = 7) {
  const event = new MouseEvent(name, { button, clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: id });
  return event;
}

it("keeps header zoom and bottom tabs outside the reserved details column", () => {
  const doc = liveReport();
  const header = doc.querySelector("header.page")!;
  const tabs = doc.querySelector("nav.tabs")!;
  const workspace = doc.querySelector(".report-workspace")!;
  const host = doc.querySelector<HTMLElement>("#details-host")!;
  expect(header.querySelector(".zoom-toolbar")).toBeTruthy();
  expect(header.querySelector(".meta")).toBeTruthy();
  expect(workspace.nextElementSibling).toBe(tabs);
  expect(host.parentElement).toBe(workspace);
  expect(doc.querySelector(".board h2, .scene-image h2")).toBeNull();
  expect(host.hidden).toBe(true);
  doc.querySelector<HTMLElement>(".comp")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(host.hidden).toBe(false);
  expect(header.closest(".details-host")).toBeNull();
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="in"]')!.click();
  expect(host.hidden).toBe(false);
  doc.querySelector<HTMLButtonElement>("[data-close]")!.click();
  expect(host.hidden).toBe(true);
});

it("anchors wheel zoom at the pointer and keeps scene view separate from photo zoom", () => {
  const doc = liveReport();
  const viewport = doc.querySelector<HTMLElement>("#scene-viewport")!;
  const event = new WheelEvent("wheel", { deltaY: -100, clientX: 210, clientY: 170, cancelable: true });
  expect(viewport.dispatchEvent(event)).toBe(false);
  const view = sceneView(doc);
  expect(view.scale).toBeCloseTo(Math.exp(0.2));
  expect((200 - view.x) / view.scale).toBeCloseTo(178);
  expect((150 - view.y) / view.scale).toBeCloseTo(128);
  expect(doc.querySelector("#photo-zoom-level")!.textContent).toBe("100%");
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="reset"]')!.click();
  expect(sceneView(doc).scale).toBe(1);
});

for (const button of [1, 2]) {
  it(`pans with mouse button ${button}, accepts negative offsets, and suppresses drag release clicks`, () => {
    const doc = liveReport();
    const viewport = doc.querySelector<HTMLElement>("#scene-viewport")!;
    const group = doc.querySelector<HTMLElement>(".comp")!;
    group.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    let captured = false, released = false;
    viewport.setPointerCapture = () => { captured = true; };
    viewport.hasPointerCapture = () => captured;
    viewport.releasePointerCapture = () => { released = true; captured = false; };
    expect(viewport.dispatchEvent(pointer("pointerdown", button, 100, 100))).toBe(false);
    expect(captured).toBe(true);
    viewport.dispatchEvent(pointer("pointermove", button, -50, -80));
    expect(sceneView(doc)).toEqual({ x: -128, y: -158, scale: 1 });
    viewport.dispatchEvent(pointer("pointerup", button, -50, -80));
    expect(released).toBe(true);
    viewport.dispatchEvent(pointer("pointermove", button, -100, -100));
    expect(sceneView(doc)).toEqual({ x: -128, y: -158, scale: 1 });
    expect(viewport.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(false);
    expect(doc.querySelector<HTMLElement>("#d0")!.hidden).toBe(false);
    viewport.dispatchEvent(pointer("pointerdown", 0, 0, 0));
    viewport.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(doc.querySelector<HTMLElement>("#d0")!.hidden).toBe(true);
  });
}

it("cleans up pan on cancellation, capture loss, and window blur, limiting context suppression to the canvas", () => {
  const doc = liveReport();
  const viewport = doc.querySelector<HTMLElement>("#scene-viewport")!;
  for (const end of ["pointercancel", "lostpointercapture", "blur"]) {
    viewport.dispatchEvent(pointer("pointerdown", 2, 100, 100));
    if (end === "blur") doc.defaultView!.dispatchEvent(new Event("blur"));
    else viewport.dispatchEvent(pointer(end, 2, 100, 100));
    const before = sceneView(doc);
    viewport.dispatchEvent(pointer("pointermove", 2, 150, 150));
    expect(sceneView(doc)).toEqual(before);
    expect(viewport.classList.contains("is-panning")).toBe(false);
  }
  expect(viewport.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }))).toBe(false);
  expect(doc.querySelector("header.page")!.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }))).toBe(true);
});

it("allows keyboard component activation immediately after panning", () => {
  const doc = liveReport();
  const viewport = doc.querySelector<HTMLElement>("#scene-viewport")!;
  viewport.dispatchEvent(pointer("pointerdown", 1, 100, 100));
  viewport.dispatchEvent(pointer("pointermove", 1, 80, 80));
  viewport.dispatchEvent(pointer("pointerup", 1, 80, 80));
  const group = doc.querySelector<HTMLElement>(".comp")!;
  group.focus();
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(doc.querySelector<HTMLElement>("#d0")!.hidden).toBe(false);
});

it("zooms the complete scene around the viewport center and leaves details unscaled", () => {
  const doc = liveReport();
  const scene = doc.querySelector<HTMLElement>(".scene")!;
  const footprint = doc.querySelector<HTMLElement>(".scene-footprint")!;
  doc.querySelector<HTMLElement>(".comp")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const details = doc.querySelector<HTMLElement>("#d0")!;
  expect(details.hidden).toBe(false);
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="in"]')!.click();
  expect(scene.style.transform).toBe("translate(-72.5px, -47.5px) scale(1.25)");
  expect(footprint.style.width).toBe("");
  expect(doc.querySelector("#scene-zoom-level")!.textContent).toBe("125%");
  expect(details.hidden).toBe(false);
  expect(details.closest(".scene-footprint")).toBeNull();
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="out"]')!.click();
  expect(scene.style.transform).toBe("translate(22px, 22px) scale(1)");
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="in"]')!.click();
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="reset"]')!.click();
  expect(scene.style.transform).toBe("translate(22px, 22px) scale(1)");
  expect(scene.querySelector(".scene-image")).toBeTruthy();
  expect(scene.querySelector(".scene-overlay")).toBeTruthy();
});

it("centers oversized photos on load and pans with the middle button", () => {
  const doc = liveReport();
  doc.querySelector<HTMLElement>(".comp")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  doc.querySelector<HTMLButtonElement>(".photo-open")!.click();
  const stage = doc.querySelector<HTMLElement>("#photo-stage")!;
  Object.defineProperties(stage, {
    scrollWidth: { value: 1400 }, clientWidth: { value: 800 },
    scrollHeight: { value: 1000 }, clientHeight: { value: 600 },
  });
  doc.querySelector<HTMLImageElement>("#viewer-image")!.dispatchEvent(new Event("load"));
  expect(stage.scrollLeft).toBe(300);
  expect(stage.scrollTop).toBe(200);
  expect(stage.dispatchEvent(pointer("pointerdown", 1, 100, 100))).toBe(false);
  stage.dispatchEvent(pointer("pointermove", 1, 70, 60));
  expect(stage.scrollLeft).toBe(330);
  expect(stage.scrollTop).toBe(240);
  stage.dispatchEvent(pointer("pointerup", 1, 70, 60));
  stage.dispatchEvent(pointer("pointermove", 1, 0, 0));
  expect(stage.scrollLeft).toBe(330);
  expect(stage.dispatchEvent(new MouseEvent("auxclick", { button: 1, cancelable: true }))).toBe(false);
});

it("opens a photo viewer, zooms and pans it, contains focus and restores the photo trigger", () => {
  const doc = liveReport();
  doc.querySelector<HTMLElement>(".comp")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const trigger = doc.querySelector<HTMLButtonElement>(".photo-open")!;
  trigger.focus(); trigger.click();
  const viewer = doc.querySelector<HTMLElement>("#photo-viewer")!;
  const stage = doc.querySelector<HTMLElement>("#photo-stage")!;
  const close = doc.querySelector<HTMLButtonElement>("#close-photo")!;
  expect(viewer.hidden).toBe(false);
  expect(doc.activeElement).toBe(close);
  expect(doc.querySelector<HTMLImageElement>("#viewer-image")!.src).toBe(trigger.querySelector<HTMLImageElement>("img")!.src);
  doc.querySelector<HTMLButtonElement>('[data-photo-zoom="in"]')!.click();
  expect(doc.querySelector("#photo-zoom-level")!.textContent).toBe("125%");
  stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, cancelable: true }));
  expect(doc.querySelector("#photo-zoom-level")!.textContent).toBe("138%");
  doc.querySelector<HTMLButtonElement>('[data-photo-zoom="reset"]')!.click();
  expect(doc.querySelector("#photo-zoom-level")!.textContent).toBe("100%");
  stage.scrollLeft = 50; stage.scrollTop = 60;
  stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 50, clientY: 60 }));
  stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 30 }));
  expect(stage.scrollLeft).toBe(80); expect(stage.scrollTop).toBe(90);
  stage.dispatchEvent(new Event("pointercancel"));
  stage.focus();
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(doc.activeElement).toBe(doc.querySelector('[data-photo-zoom="out"]'));
  close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(viewer.hidden).toBe(true);
  expect(doc.activeElement).toBe(trigger);
  expect(doc.querySelector<HTMLElement>("#d0")!.hidden).toBe(false);
});

it("keeps zoom consistent across tabs and uses natural photo dimensions for 100%", () => {
  const project = sampleDoc();
  project.boards.push({ ...project.boards[0], id: "b2", name: "Back", width: 300, height: 200 });
  const doc = liveReport(project);
  doc.querySelector<HTMLButtonElement>('[data-scene-zoom="in"]')!.click();
  const tabs = doc.querySelectorAll<HTMLButtonElement>(".tabs button");
  tabs[1].click();
  const footprints = doc.querySelectorAll<HTMLElement>(".scene-footprint");
  expect(footprints[1].style.width).toBe("");
  expect(footprints[1].querySelector<HTMLElement>(".scene")!.style.transform).toBe("translate(-72.5px, -47.5px) scale(1.25)");
  tabs[0].click();
  doc.querySelector<HTMLElement>(".comp")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  doc.querySelector<HTMLButtonElement>(".photo-open")!.click();
  const image = doc.querySelector<HTMLImageElement>("#viewer-image")!;
  Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 900 } });
  image.dispatchEvent(new Event("load"));
  expect(doc.querySelector<HTMLElement>("#photo-size")!.style.width).toBe("1200px");
  doc.querySelector<HTMLButtonElement>('[data-photo-zoom="out"]')!.click();
  expect(doc.querySelector<HTMLElement>("#photo-size")!.style.width).toBe("960px");
  doc.querySelector<HTMLButtonElement>('[data-photo-zoom="reset"]')!.click();
  expect(image.style.width).toBe("1200px");
  expect(doc.querySelector<HTMLElement>("#photo-size")!.style.height).toBe("900px");
  expect(doc.querySelector<HTMLElement>("#d0")!.hidden).toBe(false);
});

function sampleDoc(): ProjectDoc {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: 'Demo <project> "quoted"',
    description: "Front & back, rev <2>",
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [
      {
        id: "b1",
        name: "Front",
        assetHash: BOARD_HASH,
        width: 800,
        height: 600,
      },
    ],
    components: [],
    assets: {
      [BOARD_HASH]: { hash: BOARD_HASH, size: 2048, name: "front board.png" },
      [PHOTO_HASH]: { hash: PHOTO_HASH, size: 512, name: "chip photo.JPG" },
      [DATASHEET_HASH]: { hash: DATASHEET_HASH, size: 999, name: "chip.pdf" },
    },
    activeBoardId: "b1",
  };
  doc.components.push(
    {
      id: "c1",
      boardId: "b1",
      refdes: `R<1> & "'@"@ASSET:not-a-token@@`,
      typeId: "resistor",
      shape: { rect: { x: 10, y: 10, w: 60, h: 30 } },
      status: "identified",
      locked: false,
      notes: `notes <with> "quotes" & 'apostrophes' ${"<script>alert(1)</script>"}`,
      imageHash: PHOTO_HASH,
      datasheetHash: DATASHEET_HASH,
      datasheetUrl: "https://example.com/datasheet.pdf",
    },
    {
      id: "c2",
      boardId: "b1",
      refdes: "U1",
      typeId: "ic",
      shape: { ellipse: { cx: 400, cy: 300, rx: 80, ry: 40 } },
      status: "verified",
      locked: true,
    },
  );
  return doc;
}

function countToken(html: string, hash: string): number {
  return html.split(`@@ASSET:${hash}.`).length - 1;
}

it("exports multiple positioned images in one mapping tab and preserves empty tabs", () => {
  const doc = sampleDoc();
  doc.boards[0].sceneX = -100;
  doc.boards[0].sceneY = -50;
  doc.boards.push({ ...doc.boards[0], id: "b2", name: "Back", sceneX: 800, sceneY: 100 });
  doc.mappingTabs = [{ id: "t1", name: "Both sides", boardIds: ["b1", "b2"] }, { id: "t2", name: "Next board", boardIds: [] }];
  doc.activeMappingTabId = "t1";
  const parsed = new DOMParser().parseFromString(buildProjectHtml(doc), "text/html");
  expect([...parsed.querySelectorAll(".tabs button")].map((tab) => tab.textContent)).toEqual(["Both sides", "Next board"]);
  const scenes = parsed.querySelectorAll("section.board");
  expect(scenes[0].querySelectorAll(".scene-image")).toHaveLength(2);
  expect(scenes[0].querySelector('[data-image="0"]')?.getAttribute("style")).toBe("left:0px;top:0px");
  expect(scenes[0].querySelector('[data-image="1"]')?.getAttribute("style")).toBe("left:900px;top:150px");
  expect(scenes[1].textContent).toContain("No images in this tab.");
  expect(scenes[0].querySelector(".comp .label")?.hasAttribute("clip-path")).toBe(true);
});

it("escapes every user-derived string", () => {
  const html = buildProjectHtml(sampleDoc());
  expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  // Project name in <title> and header.
  expect(html).toContain("<title>Demo &lt;project&gt; &quot;quoted&quot;</title>");
  expect(new DOMParser().parseFromString(html, "text/html").querySelector("h1")!.textContent).toBe(sampleDoc().name);
  // Description.
  expect(html).toContain("Front &amp; back, rev &lt;2&gt;");
  // The hostile refdes: fully escaped, with the literal @@ASSET: fragment
  // kept as inert text (no quotes/brackets available to break out).
  expect(html).toContain("R&lt;1&gt; &amp; &quot;&#39;@&quot;@ASSET:not-a-token@@");
  // Notes never leak a raw <script>.
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

it("escapes hostile board ids and type colors in attribute contexts", () => {
  const doc = sampleDoc();
  const hostileId = 'x" onmouseover="alert(1)';
  // Move the board AND its components to the hostile id so the fixtures
  // stay attached and the details drawers actually render.
  doc.boards[0].id = hostileId;
  doc.activeBoardId = hostileId;
  for (const component of doc.components) {
    if (component.boardId === "b1") component.boardId = hostileId;
  }
  // The resistor type colors component c1's SVG fill/stroke and chip background.
  doc.types.find((type) => type.id === "resistor")!.color = '#f00" onload="alert(2)';
  const html = buildProjectHtml(doc);
  // Attribute breakout attempts are escaped everywhere they appear.
  expect(html).not.toContain(`data-board="${hostileId}"`);
  expect(html).not.toContain('x" onmouseover=');
  expect(html).toContain(`data-board="x&quot; onmouseover=&quot;alert(1)"`);
  expect(html).not.toContain('#f00" onload="alert(2)');
  expect(html).toContain('fill="#f00&quot; onload=&quot;alert(2)"');
  expect(html).toContain('background:#f00&quot; onload=&quot;alert(2)');
  // The hostile board's content still round-trips: its section, details
  // drawers, and image token are all present.
  expect(html).toContain('aria-label="Front"');
  expect(html).not.toContain("<h2>Front</h2>");
  expect(html).toContain('id="d0"');
  expect(html).toContain('id="d1"');
  expect(html).toContain(`@@ASSET:${BOARD_HASH}.png@@`);
});

it("keeps oversized boards at native dimensions in a viewport controlled by pan and zoom", () => {
  const html = buildProjectHtml(sampleDoc());
  // The content area scrolls horizontally…
  expect(html).toContain('id="scene-viewport"');
  expect(html).toContain("overflow: hidden; touch-action: none");
  // …and the frame keeps its natural width instead of a clipping max-width.
  const frameRule = html.match(/\.frame \{[^}]*\}/)![0];
  expect(frameRule).not.toContain("max-width");
});

it("renders exactly one token per referenced board and component-image hash", () => {
  const html = buildProjectHtml(sampleDoc());
  expect(countToken(html, BOARD_HASH)).toBe(1);
  expect(countToken(html, PHOTO_HASH)).toBe(1);
  // The board token uses the asset filename's extension (lowercased).
  expect(html).toContain(`@@ASSET:${BOARD_HASH}.png@@`);
  expect(html).toContain(`@@ASSET:${PHOTO_HASH}.jpg@@`);
});

it("never emits a token for datasheet hashes", () => {
  const html = buildProjectHtml(sampleDoc());
  expect(countToken(html, DATASHEET_HASH)).toBe(0);
  expect(html).not.toContain(`@@ASSET:${DATASHEET_HASH}`);
  // The datasheet URL renders as an anchor, not an inlined blob.
  expect(html).toContain('href="https://example.com/datasheet.pdf"');
});

it("keeps the adversarial literal @@ASSET: in a refdes inert and non-forging", () => {
  const doc = sampleDoc();
  doc.components[0].refdes = `@@ASSET:${"@".repeat(0)}zz@@`;
  const html = buildProjectHtml(doc);
  // The literal stays present as escaped text…
  expect(html).toContain("@@ASSET:zz@@");
  // …and no data: URI or additional token appears for it.
  expect(html).not.toMatch(/data:image\/[a-z]+;base64,/);
  expect(countToken(html, BOARD_HASH)).toBe(1);
});

it("includes every component in the details drawers", () => {
  const doc = sampleDoc();
  const hiddenOutside: Component = {
    id: "c3",
    boardId: "b1",
    refdes: "OUTSIDE1",
    typeId: "ic",
    shape: { rect: { x: 1000, y: 1000, w: 40, h: 40 } },
    status: "unknown",
    locked: false,
  };
  doc.components.push(hiddenOutside);
  const html = buildProjectHtml(doc);
  expect(html).toContain("R&lt;1&gt;");
  expect(html).toContain("U1");
  expect(html).toContain("OUTSIDE1");
  // Components are independent scene overlays, including outside all images.
  expect(html).toContain('id="d2"');
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector('.scene-overlay .comp[data-refdes="OUTSIDE1"]')).toBeTruthy();
});

it("applies crop and transform geometry to the visible picture", () => {
  const doc = sampleDoc();
  doc.boards[0] = {
    ...doc.boards[0],
    crop: { x: 100, y: 50, w: 400, h: 300 },
    rotation: 90,
    flipH: true,
    scale: 150,
  };
  const html = buildProjectHtml(doc);
  // Display size: cropped (400×300) rotated → (300×400) × 1.5 = 450×600.
  expect(html).toContain("width:450px;height:600px");
  // Clip box uses unscaled crop dims, centered, with the full transform chain.
  expect(html).toContain("left:calc(50% - 200px);top:calc(50% - 150px)");
  expect(html).toContain("transform:scale(1.5) scaleX(-1) scaleY(1) rotate(90deg)");
  // The inner pane translates the crop origin away and keeps original dims.
  expect(html).toContain("transform:translate(-100px, -50px)");
  expect(html).toContain('class="scene-overlay"');
});

it("frames arbitrary angles with the rotated AABB and keeps the chain order", () => {
  const doc = sampleDoc();
  doc.boards[0] = { ...doc.boards[0], rotation: 30 };
  const html = buildProjectHtml(doc);
  // AABB of 800×600 rotated 30°: 800·cos30 + 600·sin30 = 992.82,
  // 800·sin30 + 600·cos30 = 919.62.
  expect(html).toContain("width:992.82px;height:919.62px");
  expect(html).toContain("transform:scale(1) scaleX(1) scaleY(1) rotate(30deg)");
  // The clip box keeps the unscaled crop dims (full image here), centered.
  expect(html).toContain("left:calc(50% - 400px);top:calc(50% - 300px)");
  // Fractional degrees serialize without drift.
  doc.boards[0] = { ...doc.boards[0], rotation: 45.7, scale: 50 };
  const fractional = buildProjectHtml(doc);
  const c = Math.cos((45.7 * Math.PI) / 180);
  const s = Math.sin((45.7 * Math.PI) / 180);
  const width = (Math.abs(800 * c) + Math.abs(600 * s)) * 0.5;
  const height = (Math.abs(800 * s) + Math.abs(600 * c)) * 0.5;
  expect(fractional).toContain(`width:${Math.round(width * 100) / 100}px`);
  expect(fractional).toContain(`height:${Math.round(height * 100) / 100}px`);
  expect(fractional).toContain("transform:scale(0.5) scaleX(1) scaleY(1) rotate(45.7deg)");
});

it("builds tab markup per board and an honest empty state", () => {
  const doc = sampleDoc();
  doc.boards.push({
    id: "b2",
    name: "Back",
    assetHash: BOARD_HASH,
    width: 100,
    height: 100,
  });
  const html = buildProjectHtml(doc);
  expect(html).toContain('role="tablist"');
  expect(html.match(/role="tab"/g)?.length).toBe(2);
  expect(html).toContain("<button type=\"button\" role=\"tab\" aria-selected=\"true\">Front</button>");

  const empty = { ...doc, boards: [], components: [], activeBoardId: undefined };
  const emptyHtml = buildProjectHtml(empty);
  expect(emptyHtml).toContain("No images in this tab.");
  expect(emptyHtml).toContain('role="tablist"');
});

it("assetToken derives the extension from the asset name", () => {
  expect(assetToken("h".repeat(64), "photo.webp")).toBe(`@@ASSET:${"h".repeat(64)}.webp@@`);
  expect(assetToken("h".repeat(64), "no-extension")).toBe(`@@ASSET:${"h".repeat(64)}.png@@`);
});

it("exports descriptions and every component photo without attaching overlays to pictures", () => {
  const doc = normalizeMappingTabs(sampleDoc());
  const extraHash = "d".repeat(64);
  doc.assets[extraHash] = { hash: extraHash, name: "detail.webp", size: 100 };
  doc.components[0].description = 'Pinout <confirmed> & checked';
  doc.components[0].imageHashes = [PHOTO_HASH, extraHash];
  doc.boards[0].sceneX = 2000;
  doc.boards[0].crop = { x: 300, y: 300, w: 100, h: 100 };
  const html = buildProjectHtml(doc);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const marking = parsed.querySelector('.scene-overlay .comp[data-index="0"] .shape rect');
  expect(marking?.getAttribute("x")).toBe("10");
  expect(marking?.getAttribute("y")).toBe("10");
  expect(parsed.querySelectorAll(".scene-image .comp")).toHaveLength(0);
  expect(parsed.querySelectorAll("#d0 .photo")).toHaveLength(2);
  expect(html).toContain("Pinout &lt;confirmed&gt; &amp; checked");
  expect(countToken(html, PHOTO_HASH)).toBe(1);
  expect(countToken(html, extraHash)).toBe(1);
});

it("exports independent components after their source image was deleted", () => {
  const doc = normalizeMappingTabs(sampleDoc());
  doc.boards = [];
  doc.mappingTabs![0].boardIds = [];
  const parsed = new DOMParser().parseFromString(buildProjectHtml(doc), "text/html");
  expect(parsed.querySelectorAll(".scene-image")).toHaveLength(0);
  expect(parsed.querySelectorAll(".scene-overlay .comp")).toHaveLength(2);
});
