import { it, expect, vi, afterEach, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn<() => boolean>(),
  dialogOpen: vi.fn(),
  dialogSave: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
  save: mocks.dialogSave,
}));

import {
  assetExport,
  assetImport,
  assetImportClipboardImage,
  assetRead,
  projectClose,
  projectDelete,
  projectExportCopy,
  projectExportHtml,
  projectImportCopy,
  projectNew,
  projectOpen,
  projectSave,
  projectSaveAs,
  ProjectBridgeError,
} from "./project";
// The path pickers live in ./dialog (tauri-plugin-dialog wrappers); they are
// exercised here through the plugin mocks above.
import {
  pickDatasheetImport,
  pickExportPath,
  pickHtmlExportPath,
  pickImageImport,
  pickProjectOpen,
  pickProjectImportSource,
  pickProjectSave,
} from "./dialog";

beforeEach(() => {
  mocks.isTauri.mockReturnValue(false);
});

afterEach(() => {
  vi.resetAllMocks();
});

it("throws an honest preview error without invoking anything", async () => {
  for (const call of [
    () => projectNew("C:\\p.pcbre", "Untitled"),
    () => projectOpen("C:\\p.pcbre"),
    () => projectImportCopy("C:\\source.pcbre", "C:\\copy.pcbre"),
    () => projectSave({} as never),
    () => projectSaveAs({} as never, "C:\\q.pcbre"),
    () => projectClose(),
    () => projectExportCopy({} as never, "C:\\copy.pcbre"),
    () => projectExportHtml("<p>hi</p>", "C:\\out.html"),
    () => projectDelete(),
    () => assetImport("C:\\a.png"),
    () => assetImportClipboardImage(),
    () => assetRead("0".repeat(64)),
    () => assetExport("0".repeat(64), "C:\\out.pdf"),
    () => pickProjectOpen(),
    () => pickProjectImportSource(),
    () => pickProjectSave(),
    () => pickImageImport(),
    () => pickDatasheetImport(),
    () => pickExportPath("a.pdf"),
    () => pickHtmlExportPath("a.html"),
  ]) {
    await expect(call()).rejects.toThrow(/available in the desktop app/);
  }
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.dialogOpen).not.toHaveBeenCalled();
  expect(mocks.dialogSave).not.toHaveBeenCalled();
});

it("sends camelCase payloads for every command", async () => {
  mocks.isTauri.mockReturnValue(true);
  const doc = { schemaVersion: 1 } as never;
  mocks.invoke.mockResolvedValue({});
  await projectNew("C:\\new.pcbre", "Untitled");
  expect(mocks.invoke).toHaveBeenCalledWith("project_new", { path: "C:\\new.pcbre", name: "Untitled" });
  await projectOpen("C:\\open.pcbre");
  expect(mocks.invoke).toHaveBeenCalledWith("project_open", { path: "C:\\open.pcbre" });
  await projectImportCopy("C:\\source.pcbre", "C:\\imported.pcbre");
  expect(mocks.invoke).toHaveBeenCalledWith("project_import_copy", {
    sourcePath: "C:\\source.pcbre",
    destPath: "C:\\imported.pcbre",
  });
  await projectSave(doc);
  expect(mocks.invoke).toHaveBeenCalledWith("project_save", { doc });
  await projectSaveAs(doc, "C:\\as.pcbre");
  expect(mocks.invoke).toHaveBeenCalledWith("project_save_as", { doc, path: "C:\\as.pcbre" });
  await projectClose();
  expect(mocks.invoke).toHaveBeenCalledWith("project_close", {});
  await projectExportCopy(doc, "C:\\copy.pcbre");
  expect(mocks.invoke).toHaveBeenCalledWith("project_export_copy", { doc, path: "C:\\copy.pcbre" });
  await projectExportHtml("<p>tokens</p>", "C:\\out.html");
  expect(mocks.invoke).toHaveBeenCalledWith("project_export_html", { html: "<p>tokens</p>", path: "C:\\out.html" });
  await projectDelete();
  expect(mocks.invoke).toHaveBeenCalledWith("project_delete", {});
  await assetImport("C:\\img.png");
  expect(mocks.invoke).toHaveBeenCalledWith("asset_import", { path: "C:\\img.png" });
  await assetRead("ab");
  await assetImportClipboardImage();
  expect(mocks.invoke).toHaveBeenCalledWith("asset_import_clipboard_image", {});
  expect(mocks.invoke).toHaveBeenCalledWith("asset_read", { hash: "ab" });
  await assetExport("ab", "C:\\out.pdf");
  expect(mocks.invoke).toHaveBeenCalledWith("asset_export", { hash: "ab", destPath: "C:\\out.pdf" });
});

it("normalizes structured native errors", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockRejectedValue({
    code: "missing_blob",
    message: "A referenced project asset is missing.",
    detail: "No stored blob for hash ab.",
  });
  const error = await assetRead("ab").catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(ProjectBridgeError);
  expect((error as ProjectBridgeError).code).toBe("missing_blob");
  expect((error as ProjectBridgeError).detail).toBe("No stored blob for hash ab.");
  expect((error as Error).message).toBe("A referenced project asset is missing.");
});

it("falls back to a stable message for unusable native errors", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockRejectedValue("private native detail");
  await expect(projectOpen("C:\\x.pcbre")).rejects.toThrow(
    "The project could not be opened.",
  );
  mocks.invoke.mockRejectedValue(undefined);
  await expect(projectClose()).rejects.toThrow("The project could not be closed.");
});

it("normalizes clipboard failures without exposing unusable native details", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockRejectedValue({ code: "clipboard_no_image", message: "Copy an image first." });
  await expect(assetImportClipboardImage()).rejects.toMatchObject({ code: "clipboard_no_image", message: "Copy an image first." });
  mocks.invoke.mockRejectedValue("native implementation details");
  await expect(assetImportClipboardImage()).rejects.toThrow("The clipboard image could not be attached.");
});

it("wraps native pickers with project and asset filters", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.dialogOpen.mockResolvedValue("C:\\board.png");
  mocks.dialogSave.mockResolvedValue("C:\\target.pcbre");
  expect(await pickImageImport()).toBe("C:\\board.png");
  expect(mocks.dialogOpen).toHaveBeenCalledWith({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  expect(await pickProjectImportSource()).toBe("C:\\board.png");
  expect(mocks.dialogOpen).toHaveBeenLastCalledWith({
    multiple: false,
    directory: false,
    filters: [{ name: "PCB RE Studio project", extensions: ["pcbre"] }],
  });
  expect(await pickProjectSave("Demo.pcbre")).toBe("C:\\target.pcbre");
  expect(mocks.dialogSave).toHaveBeenCalledWith({
    defaultPath: "Demo.pcbre",
    filters: [{ name: "PCB RE Studio project", extensions: ["pcbre"] }],
  });
  expect(await pickHtmlExportPath("Demo.html")).toBe("C:\\target.pcbre");
  expect(mocks.dialogSave).toHaveBeenLastCalledWith({
    defaultPath: "Demo.html",
    filters: [{ name: "HTML document", extensions: ["html"] }],
  });
  mocks.dialogOpen.mockResolvedValue(["C:\\many.png"]);
  expect(await pickProjectOpen()).toBeNull();
  mocks.dialogSave.mockRejectedValue("native detail");
  await expect(pickExportPath("doc.pdf")).rejects.toThrow(
    "The save location could not be chosen.",
  );
});
