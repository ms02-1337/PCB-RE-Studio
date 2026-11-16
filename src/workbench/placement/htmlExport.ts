// Standalone HTML report builder (pure): renders a .pcbre document as one
// self-contained HTML file. Every user-derived string passes through
// escapeHtml; image blobs are referenced ONLY via `@@ASSET:<hash>.<ext>@@`
// tokens (see assetToken), which the Rust writer replaces with base64 data
// URIs. The embedded script is tiny, dependency-free vanilla JS because the
// file opens from file:// in the user's browser, outside the app CSP.

import type { Board, Component, CropRect, ProjectDoc, Shape } from "./projectDoc";
import { normalizeMappingTabs, UNASSIGNED_TYPE_ID } from "./projectDoc";
import { labelColor } from "./color";
import { sceneBounds, labelFontSize } from "./sceneGeometry";
import { displaySize } from "./boardTransform";
import type { BBox } from "./geometry";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The one place asset tokens are built: `@@ASSET:<hash>.<ext>@@`. The
 * extension comes from the stored asset filename. */
export function assetToken(hash: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = (dot >= 0 ? name.slice(dot + 1) : "").toLowerCase();
  return `@@ASSET:${hash}.${ext || "png"}@@`;
}

function esc(value: string | undefined): string {
  return escapeHtml(value ?? "");
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Only http(s) URLs become anchors; anything else renders as plain text so
 * user-typed hrefs can never smuggle script URLs into the report. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function shapeBBox(shape: Shape): BBox {
  if ("rect" in shape) {
    return { x: shape.rect.x, y: shape.rect.y, w: shape.rect.w, h: shape.rect.h };
  }
  if ("ellipse" in shape) {
    return {
      x: shape.ellipse.cx - shape.ellipse.rx,
      y: shape.ellipse.cy - shape.ellipse.ry,
      w: shape.ellipse.rx * 2,
      h: shape.ellipse.ry * 2,
    };
  }
  const xs = shape.polygon.points.map((p) => p.x);
  const ys = shape.polygon.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

function shapeSvg(shape: Shape): string {
  if ("rect" in shape) {
    return `<rect x="${num(shape.rect.x)}" y="${num(shape.rect.y)}" width="${num(shape.rect.w)}" height="${num(shape.rect.h)}" />`;
  }
  if ("ellipse" in shape) {
    return `<ellipse cx="${num(shape.ellipse.cx)}" cy="${num(shape.ellipse.cy)}" rx="${num(shape.ellipse.rx)}" ry="${num(shape.ellipse.ry)}" />`;
  }
  const points = shape.polygon.points.map((p) => `${num(p.x)},${num(p.y)}`).join(" ");
  return `<polygon points="${points}" />`;
}

function typeOf(doc: ProjectDoc, id: string) {
  return (
    doc.types.find((type) => type.id === id) ?? {
      id: UNASSIGNED_TYPE_ID,
      name: "Unassigned",
      color: "#8a8a8a",
      prefix: "X",
    }
  );
}

function componentSvg(doc: ProjectDoc, index: number, component: Component): string {
  const type = typeOf(doc, component.typeId);
  const box = shapeBBox(component.shape);
  const text = labelColor(type.color);
  const halo = text === "#111827" ? "#f9fafb" : "#111827";
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const fontSize = labelFontSize(box.w, box.h, component.refdes.length);
  const part = component.partNumber || component.value || "";
  return `      <g class="comp" data-index="${index}" tabindex="0" role="button"
         data-refdes="${esc(component.refdes)}" data-type="${esc(type.name)}"
         data-part="${esc(part)}" data-marking="${esc(component.marking ?? "")}">
        <g class="shape" fill="${esc(type.color)}" stroke="${esc(type.color)}">${shapeSvg(component.shape)}</g>
        ${fontSize === null ? "" : `<defs><clipPath id="label-clip-${index}">${shapeSvg(component.shape)}</clipPath></defs><text class="label" clip-path="url(#label-clip-${index})" x="${num(center.x)}" y="${num(center.y)}" font-size="${num(fontSize)}" fill="${text}" stroke="${halo}">${esc(component.refdes)}</text>`}
      </g>`;
}

function componentDetails(doc: ProjectDoc, index: number, component: Component): string {
  const type = typeOf(doc, component.typeId);
  const photoHashes = [...new Set(component.imageHashes ?? (component.imageHash ? [component.imageHash] : []))];
  const photo = photoHashes.map((hash) => `<button type="button" class="photo-open" aria-label="Enlarge photo of ${esc(component.refdes)}"><img class="photo" src="${assetToken(hash, doc.assets[hash]?.name ?? "photo.png")}" alt="Photo of ${esc(component.refdes)}" /></button>`).join("\n");
  const datasheet = component.datasheetUrl
    ? isHttpUrl(component.datasheetUrl)
      ? `<a href="${esc(component.datasheetUrl)}" target="_blank" rel="noreferrer">${esc(component.datasheetUrl)}</a>`
      : `<span>${esc(component.datasheetUrl)}</span>`
    : `<span class="muted">—</span>`;
  const field = (name: string, value: string | undefined) =>
    `<tr><th>${name}</th><td>${value ? esc(value) : "<span class=\"muted\">—</span>"}</td></tr>`;
  return `    <aside class="details" id="d${index}" data-board="${esc(component.boardId)}" hidden>
      <header><h3>${esc(component.refdes)}</h3>${component.locked ? '<span class="badge">Locked</span>' : ""}<button type="button" class="close" data-close>Close</button></header>
      <dl>
        <div><dt>Type</dt><dd><span class="chip" style="background:${esc(type.color)}"></span>${esc(type.name)}</dd></div>
        <div><dt>Status</dt><dd>${esc(component.status)}</dd></div>
      </dl>
      <table>
        ${field("Part number", component.partNumber)}
        ${field("Value", component.value)}
        ${field("Marking", component.marking)}
        ${field("Package", component.pkg)}
        ${field("Manufacturer", component.manufacturer)}
        ${field("Description", component.description)}
        <tr><th>Datasheet</th><td>${datasheet}</td></tr>
        ${field("Notes", component.notes)}
      </table>
      ${photo}
    </aside>`;
}

function boardSection(doc: ProjectDoc, board: Board, boardIndex: number, left: number, top: number): string {
  const crop: CropRect = board.crop ?? { x: 0, y: 0, w: board.width, h: board.height };
  // Frame = the rotated crop AABB × scale (generalizes the quarter-turn swap).
  const { width: frameWidth, height: frameHeight } = displaySize(board);
  const factor = (board.scale ?? 100) / 100;
  const flipX = board.flipH ? -1 : 1;
  const flipY = board.flipV ? -1 : 1;
  // Chain composes rotate → flips → scale, matching crop→rotation→flip→scale;
  // the centered clip box (unscaled crop dims) rotates about its center, so
  // its scaled AABB fills the frame for any θ.
  const transform = `scale(${num(factor)}) scaleX(${flipX}) scaleY(${flipY}) rotate(${num(board.rotation ?? 0)}deg)`;
  const asset = doc.assets[board.assetHash];
  const imgToken = assetToken(board.assetHash, asset?.name ?? "board.png");
  return `  <article class="scene-image" data-image="${boardIndex}" aria-label="${esc(board.name)}" style="left:${num(left)}px;top:${num(top)}px">
    <div class="frame" style="width:${num(frameWidth)}px;height:${num(frameHeight)}px">
      <div class="clip" style="left:calc(50% - ${crop.w / 2}px);top:calc(50% - ${crop.h / 2}px);width:${crop.w}px;height:${crop.h}px;transform:${transform}">
        <div class="inner" style="width:${board.width}px;height:${board.height}px;transform:translate(${-crop.x}px, ${-crop.y}px)">
          <img src="${imgToken}" alt="${esc(board.name)} picture" width="${board.width}" height="${board.height}" draggable="false" />
        </div>
      </div>
    </div>
  </article>`;
}

const STYLE = `:root { color-scheme: dark; --bg:#1f1f1f; --surface:#181818; --raised:#2d2d2d; --border:#363636; --text:#ccc; --muted:#a0a0a0; --accent:#ffcd11; }
@media (prefers-color-scheme: light) { :root { color-scheme: light; --bg:#fff; --surface:#f3f3f3; --raised:#e5e5e5; --border:#d0d0d0; --text:#333; --muted:#616161; } }
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body { margin: 0; height: 100dvh; display: flex; flex-direction: column; font: 14px "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); }
header.page { display: flex; flex: 0 0 auto; align-items: center; gap: 18px; padding: 8px 14px; background: var(--surface); border-bottom: 1px solid var(--border); min-width: 0; }
header.page h1 { margin: 0; font-size: 16px; min-width: 0; max-width: 35%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header.page .meta { color: var(--muted); font-size: 11px; margin: 0; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs { display: flex; flex: 0 0 auto; gap: 2px; padding: 5px 14px; border-top: 1px solid var(--border); background: var(--surface); overflow-x: auto; }
.tabs button { flex: 0 0 auto; white-space: nowrap; padding: 6px 14px; background: transparent; border: 1px solid var(--border); color: var(--text); cursor: pointer; }
.tabs button[aria-selected="true"] { background: var(--raised); border-color: var(--accent); }
.report-workspace { display: flex; flex: 1; min-height: 0; min-width: 0; }
main { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; touch-action: none; user-select: none; }
main.is-panning { cursor: grabbing; }
.board { width: 100%; height: 100%; }
.board[hidden] { display: none; }
.scene { position: absolute; left: 0; top: 0; }
.scene-image { position: absolute; }
.scene-overlay { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
.scene-overlay .comp { pointer-events: visiblePainted; }
.frame { position: relative; overflow: hidden; border: 1px solid var(--border); background: var(--surface); }
.clip { position: absolute; overflow: hidden; transform-origin: center; }
.inner { position: relative; }
.inner img, .inner svg { position: absolute; inset: 0; display: block; user-select: none; }
.comp { cursor: pointer; outline: none; }
.comp .shape { fill-opacity: 0.25; stroke-width: 2; }
.comp:hover .shape, .comp:focus .shape { fill-opacity: 0.5; stroke-width: 3.5; }
.comp .label { paint-order: stroke; stroke-width: 3px; stroke-linejoin: round; font-family: "Segoe UI", system-ui, sans-serif; font-weight: 600; pointer-events: none; }
#tooltip { position: fixed; z-index: 30; display: none; max-width: 260px; padding: 6px 9px; background: var(--raised); border: 1px solid var(--border); box-shadow: 0 6px 18px #0008; font-size: 12px; pointer-events: none; }
#tooltip .t { color: var(--muted); }
.details-host { flex: 0 0 min(360px, 42vw); width: min(360px, 42vw); min-width: 0; overflow: hidden; }
.details-host[hidden] { display: none; }
.details { width: 100%; height: 100%; padding: 14px 16px; background: var(--surface); border-left: 1px solid var(--border); overflow: auto; overscroll-behavior: contain; }
.details[hidden] { display: none; }
.details header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.details h3 { margin: 0; font-size: 16px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.details .close { flex-shrink: 0; }
.badge { font-size: 11px; padding: 2px 6px; border: 1px solid var(--accent); color: var(--accent); }
.details .close, .details table, .details dl { margin-top: 10px; }
.details button { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 3px 10px; cursor: pointer; }
.details dl { display: flex; gap: 10px; margin: 10px 0 0; }
.details dl > div { flex: 1; min-width: 0; padding: 10px; background: var(--bg); border: 1px solid var(--border); overflow-wrap: anywhere; }
.details dt { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
.details dd { margin: 2px 0 0; display: flex; align-items: center; gap: 6px; }
.chip { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.details table { border-collapse: collapse; width: 100%; font-size: 13px; }
.details th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 10px 4px 0; vertical-align: top; white-space: nowrap; }
.details td { padding: 4px 0; word-break: break-word; }
.photo { max-width: 100%; margin-top: 12px; border: 1px solid var(--border); }
.details .photo-open { width: 100%; display: block; padding: 0; margin-top: 12px; cursor: zoom-in; }
.photo-open .photo { display: block; margin: 0; width: 100%; height: auto; }
.zoom-toolbar { display: flex; align-items: center; gap: 6px; margin-left: auto; flex: 0 0 auto; }
.zoom-toolbar button, .photo-viewer button { color: var(--text); background: var(--raised); border: 1px solid var(--border); border-radius: 3px; padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--muted); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.scene-footprint { position: relative; width: 100%; height: 100%; overflow: hidden; }
.scene { transform-origin: top left; }
.photo-viewer { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: 24px; background: #000a; }
.photo-viewer[hidden] { display: none; }
.photo-dialog { display: flex; flex-direction: column; width: min(1100px, 96vw); max-height: 92vh; background: var(--bg); border: 0; border-radius: 4px; box-shadow: 0 12px 48px #0009; }
.photo-dialog header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
.photo-dialog h2 { margin: 0 auto 0 0; font-size: 14px; }
.photo-stage { display: flex; height: min(70vh, 700px); min-height: 140px; overflow: auto; padding: 12px; touch-action: none; cursor: grab; }
.photo-stage img { display: block; max-width: none; user-select: none; }
.photo-stage.is-dragging { cursor: grabbing; }
.photo-size { position: relative; flex: 0 0 auto; margin: auto; overflow: hidden; }
.photo-size img { transform-origin: top left; }
.photo-hint { margin: 0; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
a { color: var(--accent); }
.noboards { color: var(--muted); padding: 22px; }
@media (max-width: 620px) { header.page { gap: 8px; padding: 6px 8px; } header.page h1 { max-width: 24%; font-size: 13px; } header.page .meta { font-size: 10px; } .zoom-toolbar { gap: 3px; } .zoom-toolbar button { padding: 5px 7px; } .details { padding: 10px; } }`;

const SCRIPT = `(function () {
  "use strict";
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tabs button"));
  var sections = Array.prototype.slice.call(document.querySelectorAll("section.board"));
  var viewport = document.getElementById("scene-viewport");
  var detailsHost = document.getElementById("details-host");
  var sceneZoom = 1, sceneX = 22, sceneY = 22, sceneDrag = null, suppressSceneClick = false;
  function renderSceneView() {
    document.querySelectorAll(".scene").forEach(function (scene) {
      scene.style.transform = "translate(" + sceneX + "px, " + sceneY + "px) scale(" + sceneZoom + ")";
    });
    document.getElementById("scene-zoom-level").textContent = Math.round(sceneZoom * 100) + "%";
  }
  function updateSceneZoom(value, anchor) {
    var next = Math.max(0.1, Math.min(8, value));
    if (!anchor) anchor = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    var ratio = next / sceneZoom;
    sceneX = anchor.x - (anchor.x - sceneX) * ratio;
    sceneY = anchor.y - (anchor.y - sceneY) * ratio;
    sceneZoom = next;
    renderSceneView();
  }
  document.querySelectorAll("[data-scene-zoom]").forEach(function (button) {
    button.addEventListener("click", function () {
      var action = button.dataset.sceneZoom;
      updateSceneZoom(action === "reset" ? 1 : sceneZoom * (action === "in" ? 1.25 : 0.8));
    });
  });
  renderSceneView();
  viewport.addEventListener("wheel", function (event) {
    event.preventDefault();
    var rect = viewport.getBoundingClientRect();
    var delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    updateSceneZoom(sceneZoom * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  function endScenePan(event) {
    if (!sceneDrag || (event && event.pointerId !== undefined && event.pointerId !== sceneDrag.pointerId)) return;
    var drag = sceneDrag;
    sceneDrag = null;
    viewport.classList.remove("is-panning");
    if (viewport.hasPointerCapture && viewport.hasPointerCapture(drag.pointerId)) viewport.releasePointerCapture(drag.pointerId);
  }
  viewport.addEventListener("pointerdown", function (event) {
    if (event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    sceneDrag = { x: event.clientX, y: event.clientY, originX: sceneX, originY: sceneY, pointerId: event.pointerId };
    suppressSceneClick = true;
    viewport.classList.add("is-panning");
    if (viewport.setPointerCapture) viewport.setPointerCapture(event.pointerId);
    if (tooltip) tooltip.style.display = "none";
  });
  viewport.addEventListener("pointermove", function (event) {
    if (!sceneDrag || (event.pointerId !== undefined && event.pointerId !== sceneDrag.pointerId)) return;
    sceneX = sceneDrag.originX + event.clientX - sceneDrag.x;
    sceneY = sceneDrag.originY + event.clientY - sceneDrag.y;
    renderSceneView();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (name) { viewport.addEventListener(name, endScenePan); });
  window.addEventListener("blur", function () { endScenePan(); });
  viewport.addEventListener("contextmenu", function (event) { event.preventDefault(); });
  viewport.addEventListener("auxclick", function (event) { if (event.button === 1 || event.button === 2) event.preventDefault(); });
  viewport.addEventListener("pointerdown", function (event) { if (event.button === 0) suppressSceneClick = false; });
  viewport.addEventListener("click", function (event) {
    if (!suppressSceneClick) return;
    event.preventDefault(); event.stopPropagation(); suppressSceneClick = false;
  }, true);
  var viewer = document.getElementById("photo-viewer");
  var photoImage = document.getElementById("viewer-image");
  var photoStage = document.getElementById("photo-stage");
  var photoSize = document.getElementById("photo-size");
  var photoZoom = 1, photoInvoker = null, photoDrag = null;
  function updatePhotoZoom(value) {
    photoZoom = Math.max(0.1, Math.min(8, value));
    var width = photoImage.naturalWidth || photoImage.width || 1;
    var height = photoImage.naturalHeight || photoImage.height || 1;
    photoImage.style.width = width + "px";
    photoImage.style.height = height + "px";
    photoImage.style.transform = "scale(" + photoZoom + ")";
    photoSize.style.width = width * photoZoom + "px";
    photoSize.style.height = height * photoZoom + "px";
    document.getElementById("photo-zoom-level").textContent = Math.round(photoZoom * 100) + "%";
  }
  function centerPhoto() {
    photoStage.scrollLeft = Math.max(0, (photoStage.scrollWidth - photoStage.clientWidth) / 2);
    photoStage.scrollTop = Math.max(0, (photoStage.scrollHeight - photoStage.clientHeight) / 2);
  }
  photoImage.addEventListener("load", function () { updatePhotoZoom(photoZoom); centerPhoto(); });
  function closePhoto() {
    viewer.hidden = true;
    if (photoDrag && photoStage.hasPointerCapture && photoStage.hasPointerCapture(photoDrag.pointerId)) photoStage.releasePointerCapture(photoDrag.pointerId);
    photoDrag = null;
    photoStage.classList.remove("is-dragging");
    if (photoInvoker && photoInvoker.isConnected) photoInvoker.focus();
  }
  function showPhoto(button) {
    var image = button.querySelector("img");
    photoInvoker = button;
    photoImage.src = image.src;
    photoImage.alt = image.alt;
    viewer.hidden = false;
    updatePhotoZoom(1);
    centerPhoto();
    document.getElementById("close-photo").focus();
    if (tooltip) tooltip.style.display = "none";
  }
  document.querySelectorAll("[data-photo-zoom]").forEach(function (button) {
    button.addEventListener("click", function () {
      var action = button.dataset.photoZoom;
      updatePhotoZoom(action === "reset" ? 1 : photoZoom * (action === "in" ? 1.25 : 0.8));
    });
  });
  document.getElementById("close-photo").addEventListener("click", closePhoto);
  viewer.addEventListener("click", function (event) { if (event.target === viewer) closePhoto(); });
  viewer.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePhoto(); }
    if (event.key !== "Tab") return;
    var buttons = Array.prototype.slice.call(viewer.querySelectorAll("button, [tabindex='0']"));
    var first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  photoStage.addEventListener("wheel", function (event) {
    event.preventDefault();
    updatePhotoZoom(photoZoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  photoStage.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    photoDrag = { x: event.clientX, y: event.clientY, left: photoStage.scrollLeft, top: photoStage.scrollTop, pointerId: event.pointerId };
    photoStage.classList.add("is-dragging");
    if (photoStage.setPointerCapture) photoStage.setPointerCapture(event.pointerId);
  });
  photoStage.addEventListener("pointermove", function (event) {
    if (!photoDrag) return;
    photoStage.scrollLeft = photoDrag.left + photoDrag.x - event.clientX;
    photoStage.scrollTop = photoDrag.top + photoDrag.y - event.clientY;
  });
  photoStage.addEventListener("auxclick", function (event) { if (event.button === 1) event.preventDefault(); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (name) {
    photoStage.addEventListener(name, function () { photoDrag = null; photoStage.classList.remove("is-dragging"); });
  });
  function activate(index) {
    tabs.forEach(function (tab, i) { tab.setAttribute("aria-selected", i === index ? "true" : "false"); });
    sections.forEach(function (section, i) { section.hidden = i !== index; });
    hideDetails();
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { activate(index); });
  });
  if (tabs.length) activate(0);

  var tooltip = document.getElementById("tooltip");
  function fillTooltip(group, x, y) {
    if (!tooltip) return;
    tooltip.innerHTML = "";
    var strong = document.createElement("strong");
    strong.textContent = group.getAttribute("data-refdes") || "";
    tooltip.appendChild(strong);
    ["type", "part", "marking"].forEach(function (key) {
      var value = group.getAttribute("data-" + key);
      if (!value) return;
      var line = document.createElement("div");
      line.className = "t";
      line.textContent = key === "part" ? value : key.charAt(0).toUpperCase() + key.slice(1) + ": " + value;
      tooltip.appendChild(line);
    });
    tooltip.style.display = "block";
    move(x, y);
  }
  function move(x, y) {
    if (!tooltip || tooltip.style.display === "none") return;
    tooltip.style.left = Math.min(x + 14, window.innerWidth - 280) + "px";
    tooltip.style.top = Math.min(y + 14, window.innerHeight - 110) + "px";
  }
  document.addEventListener("mouseover", function (event) {
    var group = event.target && event.target.closest ? event.target.closest(".comp") : null;
    if (group) fillTooltip(group, event.clientX, event.clientY);
    else if (tooltip) tooltip.style.display = "none";
  });
  document.addEventListener("mousemove", function (event) { move(event.clientX, event.clientY); });

  var openDetails = null;
  function hideDetails() {
    if (openDetails) { openDetails.hidden = true; openDetails = null; }
    detailsHost.hidden = true;
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(".photo-viewer, .zoom-toolbar")) return;
    var photoButton = target.closest(".photo-open");
    if (photoButton) { showPhoto(photoButton); return; }
    var group = target && target.closest ? target.closest(".comp") : null;
    var closer = target && target.closest ? target.closest("[data-close]") : null;
    if (closer) { hideDetails(); return; }
    if (group) {
      hideDetails();
      var panel = document.getElementById("d" + group.getAttribute("data-index"));
      if (panel) { panel.hidden = false; detailsHost.hidden = false; openDetails = panel; }
    } else if (!target.closest(".details")) {
      hideDetails();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideDetails();
    if ((event.key === "Enter" || event.key === " ") && event.target.closest && event.target.closest(".comp")) {
      event.preventDefault(); suppressSceneClick = false; event.target.closest(".comp").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
})();`;

/** Builds the complete standalone HTML document for a project. */
export function buildProjectHtml(doc: ProjectDoc): string {
  doc = normalizeMappingTabs(doc);
  const scenes = doc.mappingTabs!;
  const tabs = scenes
    .map((tab, index) => `    <button type="button" role="tab" aria-selected="${index === 0 ? "true" : "false"}">${esc(tab.name)}</button>`)
    .join("\n");
  const sections = scenes.map((tab, index) => {
    const images = tab.boardIds.map((id) => doc.boards.find((board) => board.id === id)).filter((board): board is Board => Boolean(board));
    const components = doc.components.map((component, index) => ({ component, index })).filter((entry) => entry.component.mappingTabId === tab.id);
    const bounds = sceneBounds(images, components.map((entry) => entry.component));
    const contents = images.map((board) => boardSection(doc, board, doc.boards.indexOf(board), (board.sceneX ?? 0) - bounds.x, (board.sceneY ?? 0) - bounds.y)).join("\n");
    const overlay = components.map(({ component, index: componentIndex }) => componentSvg(doc, componentIndex, component)).join("\n");
    return `<section class="board" data-board="${index}" hidden aria-label="${esc(tab.name)}"><div class="scene-footprint" data-width="${num(bounds.width)}" data-height="${num(bounds.height)}"><div class="scene" style="width:${num(bounds.width)}px;height:${num(bounds.height)}px">${contents || '<p class="muted">No images in this tab.</p>'}<svg class="scene-overlay" viewBox="${num(bounds.x)} ${num(bounds.y)} ${num(bounds.width)} ${num(bounds.height)}" width="${num(bounds.width)}" height="${num(bounds.height)}" aria-label="Component markings">${overlay}</svg></div></div></section>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.name)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<header class="page">
  <h1 title="${esc(doc.name)}${doc.description ? ` — ${esc(doc.description)}` : ""}">${esc(doc.name)}</h1>
  <p class="meta" title="Created ${esc(doc.createdAt)} · Updated ${esc(doc.updatedAt)}">Created ${esc(doc.createdAt)} · Updated ${esc(doc.updatedAt)}</p>
<div class="zoom-toolbar" role="toolbar" aria-label="Board zoom">
  <button type="button" data-scene-zoom="out" aria-label="Zoom out">−</button>
  <output id="scene-zoom-level" aria-live="polite">100%</output>
  <button type="button" data-scene-zoom="in" aria-label="Zoom in">+</button>
  <button type="button" data-scene-zoom="reset">100%</button>
</div>
</header>
<div class="report-workspace">
<main id="scene-viewport" aria-label="Board workspace">
${sections}
</main>
<div class="details-host" id="details-host" hidden>
${doc.components.map((component, index) => componentDetails(doc, index, component)).join("\n")}
</div>
</div>
${scenes.length ? `<nav class="tabs" role="tablist" aria-label="Mapping tabs">\n${tabs}\n  </nav>` : '<p class="noboards">This project has no board images.</p>'}
<div id="tooltip" role="tooltip"></div>
<div class="photo-viewer" id="photo-viewer" hidden>
  <section class="photo-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-viewer-title">
    <header><h2 id="photo-viewer-title">Component photo</h2>
      <button type="button" data-photo-zoom="out" aria-label="Photo zoom out">−</button>
      <output id="photo-zoom-level" aria-live="polite">100%</output>
      <button type="button" data-photo-zoom="in" aria-label="Photo zoom in">+</button>
      <button type="button" data-photo-zoom="reset">100%</button>
      <button type="button" id="close-photo">Close photo</button>
    </header>
    <div class="photo-stage" id="photo-stage" tabindex="0" aria-label="Zoomable component photo"><div class="photo-size" id="photo-size"><img id="viewer-image" alt="" draggable="false" /></div></div>
    <p class="photo-hint">Scroll to zoom. Left- or middle-button drag to pan. Escape closes the photo.</p>
  </section>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}
