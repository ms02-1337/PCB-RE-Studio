import { afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { LibrarySettings } from "./LibrarySettings";
import { kicad } from "../../bridge/kicad";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => vi.restoreAllMocks());
const original={id:"old",name:"Original",path:"C:/old",diagnostics:[],variables:{KIPRJMOD:"C:/project"}};
async function setup(status:"done"|"failed") { vi.spyOn(kicad,"sources").mockResolvedValue([original]); vi.spyOn(kicad,"addSource").mockResolvedValue({id:"new",name:"New",path:"C:/new",diagnostics:[]}); vi.spyOn(kicad,"rescan").mockResolvedValue({id:"job",status,scanned:1,total:1,error:status==="failed"?"Cannot index":undefined}); vi.spyOn(kicad,"removeSource").mockResolvedValue(); render(() => <LibrarySettings />); await waitFor(() => expect((screen.getByRole("button",{name:"Change path"}) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button",{name:"Change path"})); fireEvent.input(screen.getByLabelText("Source path"),{target:{value:"C:/new"}}); fireEvent.click(screen.getByRole("button",{name:"Save and index replacement"})); }
it("indexes a replacement before removing the old source and preserves variables",async()=>{await setup("done");await waitFor(()=>expect(kicad.removeSource).toHaveBeenCalledWith("old"));expect(kicad.addSource).toHaveBeenCalledWith("C:/new",original.variables);expect(vi.mocked(kicad.rescan).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(kicad.removeSource).mock.invocationCallOrder[0]);});
it("retains the old source when replacement indexing fails",async()=>{await setup("failed");await waitFor(()=>expect(screen.getByRole("status").textContent).toBe("Cannot index"));expect(kicad.removeSource).not.toHaveBeenCalled();expect(screen.getByText("C:/old")).toBeTruthy();});
