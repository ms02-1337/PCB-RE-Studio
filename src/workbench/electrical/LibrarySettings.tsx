import { createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { kicad, type LibrarySource } from "../../bridge/kicad";
import { pickDirectory } from "../../bridge/dialog";
import { ActionIcon } from "../ActionIcon";

export function LibrarySettings() {
  const [sources, setSources] = createSignal<LibrarySource[]>([]);
  const [path, setPath] = createSignal("");
  const [variables, setVariables] = createSignal("");
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [job, setJob] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let alive = true;
  onCleanup(() => { alive = false; });
  async function run(action: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await action(); } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive) setBusy(false); }
  }
  async function refresh() { const result = await kicad.sources(); if (alive) setSources(result); }
  onMount(() => { if (isTauri()) void run(refresh); });
  async function scan(id: string) {
    let state = await kicad.rescan(id);
    if (!alive) return;
    setJob(state.id);
    try {
      while (alive && state.status === "running") {
        setStatus(`Indexing ${state.scanned} / ${state.total}`);
        await new Promise(resolve => setTimeout(resolve, 200));
        if (alive) state = await kicad.job(state.id);
      }
      if (alive) { setStatus(state.error ?? state.status); await refresh(); }
    } finally { if (alive) setJob(""); }
  }
  return <><h3>KiCad libraries</h3><p>Register an installation, library directory, .pretty folder, .kicad_mod, .kicad_sym or library table. Project snapshots stay unchanged when sources are rescanned.</p>
    <Show when={!isTauri()}><p>Library access requires the desktop app.</p></Show>
    <div class="settings-field">
      <span>Source path</span>
      <input aria-label="Source path" disabled={!isTauri() || busy()} value={path()} onInput={e => setPath(e.currentTarget.value)} />
      <div class="library-path-actions">
        <button disabled={!isTauri() || busy()} onClick={() => void run(async () => {
          const dir = await pickDirectory();
          if (dir) setPath(dir);
        })}><ActionIcon name="Browse" />Browse…</button>
        <button disabled={busy()} onClick={() => void run(async () => {
          if (!navigator.clipboard?.readText) throw new Error("The clipboard is empty or unreadable.");
          const text = (await navigator.clipboard.readText()).trim();
          if (text) setPath(text);
          else throw new Error("The clipboard is empty or unreadable.");
        })}><ActionIcon name="Paste" />Paste</button>
      </div>
    </div>
    <label class="settings-field">Path variables (JSON)<input disabled={busy()} value={variables()} placeholder={'{"KIPRJMOD":"C:/project"}'} onInput={e => setVariables(e.currentTarget.value)} /></label>
    <button disabled={!isTauri() || busy() || !path().trim()} onClick={() => void run(async () => {
      const parsed: unknown = variables().trim() ? JSON.parse(variables()) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every(v => typeof v === "string")) throw new Error("Path variables must be an object of string values.");
      const source = await kicad.addSource(path().trim(), parsed as Record<string, string>); await refresh(); await scan(source.id);
    })}>Add and index source</button>
    <For each={sources()}>{source => <div><strong>{source.name}</strong><p>{source.path}</p><button disabled={busy()} onClick={() => void run(() => scan(source.id))}>Rescan</button><button disabled={busy()} onClick={() => void run(async () => { await kicad.removeSource(source.id); await refresh(); })}>Remove source</button><For each={source.diagnostics}>{d => <p>{d}</p>}</For></div>}</For>
    <p role="status">{status()}</p><Show when={job()}><button onClick={() => void run(async () => { await kicad.cancel(job()); })}>Cancel indexing</button></Show><Show when={error()}><p role="alert">{error()}</p></Show>
  </>;
}
