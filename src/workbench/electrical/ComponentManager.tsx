import {
  createEffect,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import {
  kicad,
  type ComponentDefinition,
  type LibraryEntry,
  type LibrarySource,
} from "../../bridge/kicad";
import { visualId } from "../visual/model";
import { drawFootprint, drawGraphics, terminalNumbers } from "./domain";
export function ComponentManager(props: {
  initial?: ComponentDefinition;
  onClose: () => void;
  onPlace: (d: ComponentDefinition) => void;
  onApply?: (d: ComponentDefinition) => void;
}) {
  const [definition, setDefinition] = createSignal<
      ComponentDefinition | undefined
    >(props.initial ? structuredClone(props.initial) : undefined),
    [saved, setSaved] = createSignal<ComponentDefinition[]>([]),
    [sources, setSources] = createSignal<LibrarySource[]>([]),
    [path, setPath] = createSignal(""),
    [query, setQuery] = createSignal(""),
    [kind, setKind] = createSignal<"footprint" | "symbol">("footprint"),
    [entries, setEntries] = createSignal<LibraryEntry[]>([]),
    [total, setTotal] = createSignal(0),
    [offset, setOffset] = createSignal(0),
    [error, setError] = createSignal(""),
    [status, setStatus] = createSignal(""),
    [job, setJob] = createSignal(""),
    [busy, setBusy] = createSignal(false);
  let alive = true,
    request = 0;
  onCleanup(() => {
    alive = false;
  });
  const guard = async <T,>(
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    setError("");
    try {
      return await action();
    } catch (e) {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    }
  };
  const refresh = async () => {
    const result = await guard(() =>
      Promise.all([kicad.definitions(), kicad.sources()]),
    );
    if (result && alive) {
      setSaved(result[0]);
      setSources(result[1]);
    }
  };
  onMount(() => {
    void refresh();
  });
  createEffect(() => {
    const q = query(),
      k = kind(),
      o = offset(),
      token = ++request;
    void guard(() => kicad.search(k, q, o, 50)).then((page) => {
      if (page && alive && token === request) {
        setEntries(page.entries);
        setTotal(page.total);
      }
    });
  });
  const patch = (values: Partial<ComponentDefinition>) =>
    setDefinition((d) => (d ? { ...d, ...values } : d));
  const choose = async (entry: LibraryEntry) => {
    setBusy(true);
    if (entry.kind === "footprint") {
      const fp = await guard(() => kicad.footprint(entry.id));
      if (fp && alive) {
        const d = definition();
        setDefinition({
          ...d,
          id: d?.id ?? visualId(),
          name: d?.name ?? fp.name,
          partName: d?.partName ?? "",
          value: d?.value ?? "",
          referencePrefix: d?.referencePrefix ?? "U",
          footprint: fp,
          pinMap: Object.fromEntries(
            fp.pads.filter((p) => p.number).map((p) => [p.number, p.number]),
          ),
        });
      }
    } else {
      const symbol = await guard(() => kicad.symbol(entry.id));
      if (symbol && alive)
        patch({
          symbol,
          referencePrefix:
            definition()?.referencePrefix === "U"
              ? symbol.reference
              : definition()?.referencePrefix,
        });
    }
    setBusy(false);
  };
  const scan = async (id: string) => {
    const started = await guard(() => kicad.rescan(id));
    if (!started) return;
    setJob(started.id);
    let current = started;
    while (alive && current.status === "running") {
      setStatus(`Indexing ${current.scanned} / ${current.total}`);
      await new Promise((r) => setTimeout(r, 200));
      const result = await guard(() => kicad.job(started.id));
      if (!result) break;
      current = result;
    }
    if (alive) {
      setJob("");
      setStatus(
        current.status === "done"
          ? "Index ready"
          : (current.error ?? current.status),
      );
      void refresh();
      setQuery(query() + " ");
    }
  };
  const save = async (place = false) => {
    const d = definition();
    if (!d) return;
    if (!d.name.trim()) {
      setError("Enter a component name.");
      return;
    }
    if (d.footprint.diagnostics.length || d.symbol?.diagnostics.length) {
      setError("Resolve unsupported library geometry before use.");
      return;
    }
    const result = await guard(async () => {
      await kicad.saveDefinition(d);
      return true;
    });
    if (result && alive) {
      await refresh();
      if (place) props.onPlace(structuredClone(d));
    }
  };
  const Preview = (p: { symbol?: boolean }) => {
    let canvas!: HTMLCanvasElement;
    createEffect(() => {
      const d = definition();
      if (!d || !canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, 400, 220);
      ctx.save();
      ctx.translate(200, 110);
      ctx.scale(8, 8);
      ctx.strokeStyle = "#ffcd11";
      ctx.fillStyle = "#ffcd11";
      if (p.symbol && d.symbol) {
        const unit = d.symbol.units[0];
        drawGraphics(ctx, unit?.graphics ?? []);
        for (const pin of unit?.pins ?? []) {
          ctx.font = "1px sans-serif";
          ctx.fillText(`${pin.number} ${pin.name}`, pin.x, pin.y);
          ctx.beginPath();
          ctx.moveTo(pin.x, pin.y);
          ctx.lineTo(
            pin.x + Math.cos((pin.rotation * Math.PI) / 180) * pin.length,
            pin.y + Math.sin((pin.rotation * Math.PI) / 180) * pin.length,
          );
          ctx.stroke();
        }
      } else if (!p.symbol)
        drawFootprint(
          ctx,
          {
            id: "preview",
            definition: d,
            reference: d.referencePrefix,
            value: d.value,
            partName: d.partName,
            x: 0,
            y: 0,
            layerId: "",
            rotation: 0,
            scale: 1,
            terminals: [],
          },
          1,
          "#ffcd11",
        );
      else {
        ctx.strokeRect(-10, -8, 20, 16);
        ctx.font = "1px sans-serif";
        terminalNumbers(d).forEach((n, i) => ctx.fillText(n, -12, -6 + i * 2));
      }
      ctx.restore();
    });
    return (
      <canvas
        ref={canvas}
        width={400}
        height={220}
        aria-label={p.symbol ? "Symbol preview" : "Footprint preview"}
      />
    );
  };
  return (
    <div
      class="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <section
        class="palette component-manager"
        role="dialog"
        aria-modal="true"
        aria-label="Component library"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
          if (e.key === "Tab") {
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not([disabled]),input:not([disabled]),select:not([disabled])",
              ),
            );
            if (e.shiftKey && document.activeElement === items[0]) {
              e.preventDefault();
              items.at(-1)?.focus();
            } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
              e.preventDefault();
              items[0]?.focus();
            }
          }
        }}
      >
        <header class="dialog-header">
          <h2>Component library</h2>
        </header>
        <div class="component-manager-body">
          <aside>
            <h3>Saved components</h3>
            <button autofocus onClick={() => setDefinition(undefined)}>
              New component
            </button>
            <For each={saved()}>
              {(d) => (
                <div>
                  <button onClick={() => setDefinition(structuredClone(d))}>
                    {d.name}
                  </button>
                  <button
                    aria-label={`Duplicate ${d.name}`}
                    onClick={() =>
                      setDefinition({
                        ...structuredClone(d),
                        id: visualId(),
                        name: d.name + " copy",
                      })
                    }
                  >
                    Duplicate
                  </button>
                  <button
                    aria-label={`Delete ${d.name}`}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete local definition ${d.name}? Placed components stay unchanged.`,
                        )
                      )
                        void guard(() => kicad.deleteDefinition(d.id)).then(
                          refresh,
                        );
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </For>
            <h3>Library sources</h3>
            <input
              aria-label="Library path"
              value={path()}
              onInput={(e) => setPath(e.currentTarget.value)}
              placeholder="KiCad install, library directory or file"
            />
            <button
              onClick={() =>
                void guard(() => kicad.addSource(path())).then((s) => {
                  if (s) {
                    void refresh();
                    void scan(s.id);
                  }
                })
              }
            >
              Add source
            </button>
            <For each={sources()}>
              {(s) => (
                <div>
                  <span title={s.path}>{s.name}</span>
                  <button onClick={() => void scan(s.id)}>Rescan</button>
                  <button
                    onClick={() =>
                      void guard(() => kicad.removeSource(s.id)).then(refresh)
                    }
                  >
                    Remove
                  </button>
                  <For each={s.diagnostics}>{(d) => <p>{d}</p>}</For>
                </div>
              )}
            </For>
            <p role="status">{status()}</p>
            <Show when={job()}>
              <button onClick={() => void kicad.cancel(job())}>
                Cancel indexing
              </button>
            </Show>
          </aside>
          <main>
            <div class="component-pickers">
              <select
                aria-label="Library kind"
                value={kind()}
                onChange={(e) => {
                  setKind(e.currentTarget.value as "footprint" | "symbol");
                  setOffset(0);
                }}
              >
                <option value="footprint">Footprints</option>
                <option value="symbol">Symbols</option>
              </select>
              <input
                aria-label="Search library"
                value={query()}
                onInput={(e) => {
                  setQuery(e.currentTarget.value);
                  setOffset(0);
                }}
              />
              <div class="library-results">
                <For each={entries()}>
                  {(e) => (
                    <button
                      disabled={
                        busy() || (e.kind === "symbol" && !definition())
                      }
                      onClick={() => void choose(e)}
                    >
                      {e.name}
                    </button>
                  )}
                </For>
              </div>
              <button
                disabled={!offset()}
                onClick={() => setOffset(Math.max(0, offset() - 50))}
              >
                Previous
              </button>
              <span>
                {offset() + 1}–{Math.min(offset() + 50, total())} / {total()}
              </span>
              <button
                disabled={offset() + 50 >= total()}
                onClick={() => setOffset(offset() + 50)}
              >
                Next
              </button>
            </div>
            <Show when={definition()} keyed>
              {(d) => (
                <>
                  <div class="component-fields">
                    <For
                      each={
                        [
                          "name",
                          "partName",
                          "value",
                          "referencePrefix",
                        ] as const
                      }
                    >
                      {(key) => (
                        <label>
                          {key}
                          <input
                            aria-label={`Component ${key}`}
                            value={d[key]}
                            onInput={(e) =>
                              patch({ [key]: e.currentTarget.value })
                            }
                          />
                        </label>
                      )}
                    </For>
                  </div>
                  <div class="component-previews">
                    <div>
                      <h3>{d.footprint.name}</h3>
                      <Preview />
                    </div>
                    <div>
                      <h3>{d.symbol?.name ?? "Generic symbol"}</h3>
                      <Preview symbol />
                      <button onClick={() => patch({ symbol: undefined })}>
                        Use generic symbol
                      </button>
                    </div>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Pad</th>
                        <th>Symbol pin</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={terminalNumbers(d)}>
                        {(number) => (
                          <tr>
                            <td>{number}</td>
                            <td>
                              <select
                                aria-label={`Map pad ${number}`}
                                value={d.pinMap[number] ?? ""}
                                onChange={(e) =>
                                  patch({
                                    pinMap: {
                                      ...d.pinMap,
                                      [number]: e.currentTarget.value,
                                    },
                                  })
                                }
                              >
                                <option value="">Unmapped</option>
                                <For
                                  each={[
                                    ...new Map(
                                      d.symbol?.units
                                        .flatMap((u) => u.pins)
                                        .map((p) => [p.number, p]) ?? [],
                                    ).values(),
                                  ]}
                                >
                                  {(p) => (
                                    <option value={p.number}>
                                      {p.number} – {p.name}
                                    </option>
                                  )}
                                </For>
                                <Show when={!d.symbol}>
                                  <option value={number}>{number}</option>
                                </Show>
                              </select>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </>
              )}
            </Show>
          </main>
        </div>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <footer class="dialog-actions">
          <button onClick={props.onClose}>Close</button>
          <button disabled={!definition()} onClick={() => void save()}>
            Save to library
          </button>
          <Show when={props.onApply}>
            <button
              disabled={!definition()}
              onClick={() => {
                const d = definition();
                if (d) props.onApply?.(d);
              }}
            >
              Apply replacement
            </button>
          </Show>
          <button disabled={!definition()} onClick={() => void save(true)}>
            Place
          </button>
        </footer>
      </section>
    </div>
  );
}
