// Project IPC wrappers. Payloads are camelCase here and snake_case on the
// Rust side (`#[tauri::command]` maps automatically). Errors are normalized to
// ProjectBridgeError; browser preview throws honest errors instead of faking.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AssetInfo, ProjectDoc } from "../workbench/placement/projectDoc";

export interface LoadedProject {
  doc: ProjectDoc;
  assets: Record<string, AssetInfo>;
  path: string;
}

export interface SaveResult {
  path: string;
  bytes: number;
  blobCount: number;
  savedAt: string;
}

export class ProjectBridgeError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "ProjectBridgeError";
    this.code = code;
    this.detail = detail;
  }
}

const PREVIEW_MESSAGE = "Projects are available in the desktop app.";

function preview(): ProjectBridgeError {
  return new ProjectBridgeError("preview_unavailable", PREVIEW_MESSAGE);
}

function normalize(error: unknown, fallback: string): ProjectBridgeError {
  if (error instanceof ProjectBridgeError) return error;
  if (error && typeof error === "object" && "message" in error) {
    const raw = error as { code?: unknown; message?: unknown; detail?: unknown };
    return new ProjectBridgeError(
      typeof raw.code === "string" ? raw.code : "unknown",
      typeof raw.message === "string" && raw.message ? raw.message : fallback,
      typeof raw.detail === "string" ? raw.detail : undefined,
    );
  }
  return new ProjectBridgeError("unknown", fallback);
}

async function call<T>(command: string, payload: Record<string, unknown>, fallback: string): Promise<T> {
  if (!isTauri()) throw preview();
  try {
    return await invoke<T>(command, payload);
  } catch (error) {
    throw normalize(error, fallback);
  }
}

export function projectNew(path: string, name: string): Promise<LoadedProject> {
  return call("project_new", { path, name }, "The project could not be created.");
}

export function projectOpen(path: string): Promise<LoadedProject> {
  return call("project_open", { path }, "The project could not be opened.");
}

/** Copies a validated project to a new file and makes that copy active. */
export function projectImportCopy(sourcePath: string, destPath: string): Promise<LoadedProject> {
  return call(
    "project_import_copy",
    { sourcePath, destPath },
    "The project could not be imported.",
  );
}

export function projectSave(doc: ProjectDoc): Promise<SaveResult> {
  return call("project_save", { doc }, "The project could not be saved.");
}

export function projectSaveAs(doc: ProjectDoc, path: string): Promise<SaveResult> {
  return call("project_save_as", { doc, path }, "The project could not be saved.");
}

export function projectClose(): Promise<null> {
  return call("project_close", {}, "The project could not be closed.");
}

/** Saves a standalone copy of the project; the open project stays open. */
export function projectExportCopy(doc: ProjectDoc, path: string): Promise<SaveResult> {
  return call("project_export_copy", { doc, path }, "The project copy could not be saved.");
}

/** Writes a standalone HTML document, inlining referenced image blobs. */
export function projectExportHtml(html: string, path: string): Promise<number> {
  return call("project_export_html", { html, path }, "The HTML export could not be written.");
}

/** Deletes the open container file and closes the project. */
export function projectDelete(): Promise<null> {
  return call("project_delete", {}, "The project could not be deleted.");
}

export function assetImport(path: string): Promise<AssetInfo> {
  return call("asset_import", { path }, "The asset could not be imported.");
}

/** Reads and stages the native clipboard image; pixels stay in Rust. */
export function assetImportClipboardImage(): Promise<AssetInfo> {
  return call("asset_import_clipboard_image", {}, "The clipboard image could not be attached.");
}

export function assetRead(hash: string): Promise<ArrayBuffer> {
  return call("asset_read", { hash }, "The asset could not be read.");
}

export function assetExport(hash: string, destPath: string): Promise<null> {
  return call("asset_export", { hash, destPath }, "The asset could not be exported.");
}
