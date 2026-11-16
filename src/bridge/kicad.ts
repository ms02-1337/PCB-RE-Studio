import { invoke, isTauri } from "@tauri-apps/api/core";
import { ProjectBridgeError } from "./project";
export interface KPoint { x: number; y: number }
export interface KGraphic { rotation?: number; fontSize?: {width:number;height:number}; kind: "line"|"rect"|"circle"|"arc"|"polyline"|"bezier"|"text"; points: KPoint[]; width: number; fill: boolean; text?: string; layer?: string }
export interface KPad { anchor?: "rect"|"circle"; type?: "smd"|"thru_hole"|"np_thru_hole"|"connect"; number: string; x: number; y: number; width: number; height: number; rotation: number; shape: "circle"|"rect"|"oval"|"roundrect"|"trapezoid"|"custom"; drill?: { width: number; height: number; x: number; y: number }; plated: boolean; layers: string[]; roundrectRatio?: number; primitives?: KGraphic[] }
export interface KFootprint { id: string; name: string; source: string; raw: string; pads: KPad[]; graphics: KGraphic[]; diagnostics: string[] }
export interface KPin { number: string; name: string; x: number; y: number; rotation: number; length: number; electricalType: string; hidden: boolean }
export interface KSymbolUnit { unit: number; bodyStyle: number; pins: KPin[]; graphics: KGraphic[] }
export interface KSymbol { id: string; name: string; source: string; raw: string; reference: string; units: KSymbolUnit[]; diagnostics: string[] }
export interface ComponentDefinition { id: string; name: string; partName: string; value: string; referencePrefix: string; footprint: KFootprint; symbol?: KSymbol; pinMap: Record<string,string> }
export interface LibrarySource { variables?: Record<string,string>; id: string; path: string; name: string; diagnostics: string[] }
export interface LibraryEntry { id: string; name: string; sourceId: string; kind: "footprint"|"symbol" }
export interface LibraryPage { entries: LibraryEntry[]; total: number }
export interface LibraryJob { id: string; status: "running"|"done"|"cancelled"|"failed"; scanned: number; total: number; error?: string }
async function call<T>(command:string,payload:Record<string,unknown>={}):Promise<T>{ if(!isTauri())throw new ProjectBridgeError("preview_unavailable","KiCad libraries are available in the desktop app."); try{return await invoke<T>(command,payload);}catch(e){const error=e as {code?:string;message?:string;detail?:string};throw new ProjectBridgeError(error.code??"unknown",error.message??"KiCad operation failed.",error.detail);} }
export const kicad = {
 sources:()=>call<LibrarySource[]>("kicad_sources"),
 addSource:(path:string,variables:Record<string,string>={})=>call<LibrarySource>("kicad_add_source",{path,variables}),
 removeSource:(id:string)=>call<void>("kicad_remove_source",{id}),
 rescan:(sourceId:string)=>call<LibraryJob>("kicad_rescan",{sourceId}),
 job:(id:string)=>call<LibraryJob>("kicad_job",{id}),
 cancel:(id:string)=>call<void>("kicad_cancel",{id}),
 search:(kind:"footprint"|"symbol",query:string,offset=0,limit=100)=>call<LibraryPage>("kicad_search",{kind,query,offset,limit}),
 footprint:(id:string)=>call<KFootprint>("kicad_footprint",{id}),
 symbol:(id:string)=>call<KSymbol>("kicad_symbol",{id}),
 definitions:()=>call<ComponentDefinition[]>("kicad_definitions"),
 saveDefinition:(definition:ComponentDefinition)=>call<void>("kicad_save_definition",{definition}),
 deleteDefinition:(id:string)=>call<void>("kicad_delete_definition",{id}),
 exportText:(path:string,text:string)=>call<void>("kicad_export_text",{path,text}),
 exportFiles:(path:string,files:{name:string;text:string}[])=>call<void>("kicad_export_files",{path,files}),
};
