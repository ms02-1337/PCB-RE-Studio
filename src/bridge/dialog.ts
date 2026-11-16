// Native file-picker wrappers (tauri-plugin-dialog). Only paths cross the
// bridge; every byte of project or asset IO stays in our Rust commands.

import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

const PREVIEW_MESSAGE = "File pickers are available in the desktop app.";

const PROJECT_FILTERS = [{ name: "PCB RE Studio project", extensions: ["pcbre"] }];
const IMAGE_FILTERS = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }];
const DATASHEET_FILTERS = [{ name: "Datasheets", extensions: ["pdf"] }];
const HTML_FILTERS = [{ name: "HTML document", extensions: ["html"] }];

function guard(): void {
  if (!isTauri()) throw new Error(PREVIEW_MESSAGE);
}

async function pickOpen(filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  guard();
  try {
    const selection = await open({ multiple: false, directory: false, filters });
    return typeof selection === "string" ? selection : null;
  } catch {
    throw new Error("The file picker could not be opened.");
  }
}

/** Directory-only picker (no filters); covered by dialog:allow-open. */
export async function pickDirectory(): Promise<string | null> {
  guard();
  try {
    const selection = await open({ multiple: false, directory: true });
    return typeof selection === "string" ? selection : null;
  } catch {
    throw new Error("The folder picker could not be opened.");
  }
}

async function pickSave(
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> {
  guard();
  try {
    return await save({ defaultPath: defaultName, filters });
  } catch {
    throw new Error("The save location could not be chosen.");
  }
}

export function pickProjectOpen(): Promise<string | null> {
  return pickOpen(PROJECT_FILTERS);
}

export function pickProjectImportSource(): Promise<string | null> {
  return pickOpen(PROJECT_FILTERS);
}

export function pickProjectSave(defaultName = "Untitled.pcbre"): Promise<string | null> {
  return pickSave(defaultName, PROJECT_FILTERS);
}

export function pickImageImport(): Promise<string | null> {
  return pickOpen(IMAGE_FILTERS);
}

export function pickDatasheetImport(): Promise<string | null> {
  return pickOpen(DATASHEET_FILTERS);
}

export function pickExportPath(defaultName: string): Promise<string | null> {
  return pickSave(defaultName, DATASHEET_FILTERS);
}

export function pickHtmlExportPath(defaultName: string): Promise<string | null> {
  return pickSave(defaultName, HTML_FILTERS);
}
