import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { kicad } from "../../bridge/kicad";
import type { PlacementStore } from "../placement/store";
import type { ElectricalComponent } from "./model";
import { ActionIcon } from "../ActionIcon";
import "./electrical.css";

export interface BomMember {
  pcbId: string;
  pcbName: string;
  component: ElectricalComponent;
}
export interface BomRow {
  key: string;
  members: BomMember[];
}
export function groupBom(members: BomMember[]): BomRow[] {
  const groups = new Map<string, BomMember[]>();
  for (const member of members) {
    const c = member.component;
    const key = JSON.stringify([
      c.value,
      c.partName,
      c.definition.footprint.name,
      c.definition.footprint.raw,
      c.definition.footprint.pads,
      c.definition.footprint.graphics,
      c.definition.symbol?.name ?? "",
      c.definition.symbol?.raw ?? "",
      c.definition.symbol?.units ?? [],
      Object.entries(c.definition.pinMap).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ]);
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  return [...groups].map(([key, list]) => ({
    key,
    members: list.sort(
      (a, b) =>
        a.component.reference.localeCompare(b.component.reference, undefined, {
          numeric: true,
        }) || a.pcbName.localeCompare(b.pcbName),
    ),
  }));
}
export function bomCsv(rows: BomRow[], includePcb = false): string {
  const quote = (value: string | number) =>
    `"${String(value).replaceAll('"', '""')}"`;
  return [
    [
      "ID",
      "Quantity",
      "Value",
      "Footprint",
      "Symbol",
      "Part name",
      "References",
    ],
    ...rows.map((row, i) => {
      const c = row.members[0].component;
      return [
        i + 1,
        row.members.length,
        c.value,
        c.definition.footprint.name,
        c.definition.symbol?.name ?? "Generic (unresolved)",
        c.partName,
        row.members
          .map(
            (m) =>
              `${includePcb ? `${m.pcbName}:` : ""}${m.component.reference}`,
          )
          .join(", "),
      ];
    }),
  ]
    .map((row) => row.map(quote).join(","))
    .join("\r\n");
}

export function BomEditableCell(props: {
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.value);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (!editing()) {
      setDraft(props.value);
    }
  });

  const startEditing = () => {
    setDraft(props.value);
    setEditing(true);
    setTimeout(() => {
      inputRef?.focus();
      inputRef?.select();
    }, 0);
  };

  const commit = () => {
    if (!editing()) return;
    const next = draft();
    setEditing(false);
    if (next !== props.value) {
      props.onChange(next);
    }
  };

  return (
    <div class="bom-editable-cell">
      <Show
        when={editing()}
        fallback={
          <span
            tabIndex={0}
            role="button"
            class="bom-editable-text"
            aria-label={props.label}
            title="Click to edit"
            onClick={startEditing}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                startEditing();
              }
            }}
          >
            {props.value ? (
              props.value
            ) : (
              <span class="bom-editable-placeholder">—</span>
            )}
          </span>
        }
      >
        <input
          ref={(el) => {
            inputRef = el;
            setTimeout(() => {
              el.focus();
              el.select();
            }, 0);
          }}
          aria-label={props.label}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
            } else if (e.key === "Escape") {
              setDraft(props.value);
              setEditing(false);
            }
          }}
        />
      </Show>
    </div>
  );
}

export function BomPanel(props: {
  store: PlacementStore;
  onNavigate?: (componentId: string) => void;
  onReplace?: (ids: string[]) => void;
}) {
  const [filter, setFilter] = createSignal("active");
  const [query, setQuery] = createSignal("");
  const [modalKey, setModalKey] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>([]);
  const [error, setError] = createSignal("");
  const rows = createMemo(() =>
    groupBom(
      (props.store.visual.editor()?.pcbs ?? [])
        .filter(
          (p) =>
            filter() === "all" || p.id === props.store.visual.activePcb()?.id,
        )
        .flatMap((p) =>
          (p.components ?? []).map((component) => ({
            pcbId: p.id,
            pcbName: p.name,
            component,
          })),
        )
        .filter((m) =>
          `${m.component.reference} ${m.component.value} ${m.component.partName} ${m.component.definition.footprint.name} ${m.component.definition.symbol?.name ?? ""}`
            .toLowerCase()
            .includes(query().toLowerCase()),
        ),
    ),
  );
  const activeModalRow = () => rows().find((r) => r.key === modalKey());

  const allSelected = () => {
    const m = activeModalRow()?.members ?? [];
    return m.length > 0 && m.every((x) => selected().includes(x.component.id));
  };

  const toggleSelectAll = (checked: boolean) => {
    const m = activeModalRow()?.members ?? [];
    if (checked) {
      setSelected(m.map((x) => x.component.id));
    } else {
      setSelected([]);
    }
  };

  const edit = (
    members: BomMember[],
    field: "reference" | "value" | "partName",
    value: string,
  ) => {
    setError("");
    const byPcb = new Map<string, BomMember[]>();
    for (const member of members)
      byPcb.set(member.pcbId, [...(byPcb.get(member.pcbId) ?? []), member]);
    const updates = [];
    for (const [id, list] of byPcb) {
      const p = props.store.visual.editor()?.pcbs.find((pcb) => pcb.id === id);
      if (!p) continue;
      const next = structuredClone(p);
      if (
        field === "reference" &&
        (!value.trim() ||
          next.components?.some(
            (c) =>
              c.reference === value.trim() &&
              !list.some((m) => m.component.id === c.id),
          ))
      ) {
        setError("Reference must be nonempty and unique within its PCB.");
        return;
      }
      for (const c of next.components ?? [])
        if (list.some((m) => m.component.id === c.id))
          c[field] = field === "reference" ? value.trim() : value;
      updates.push(next);
    }
    props.store.visual.replacePcbs(updates);
  };
  const exportCsv = async () => {
    try {
      const path = await save({
        defaultPath: "bom.csv",
        filters: [{ name: "BOM CSV", extensions: ["csv"] }],
      });
      if (path)
        await kicad.exportText(path, bomCsv(rows(), filter() === "all"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "BOM export failed.");
    }
  };
  return (
    <section class="electrical-panel" aria-label="Bill of materials">
      <div class="electrical-toolbar">
        <h1>Bill of materials</h1>
        <span class="electrical-separator" aria-hidden="true" />
        <label>
          PCB scope{" "}
          <select
            value={filter()}
            onChange={(e) => {
              setFilter(e.currentTarget.value);
              setModalKey("");
            }}
          >
            <option value="active">Active PCB</option>
            <option value="all">All PCBs</option>
          </select>
        </label>
        <input
          aria-label="Search BOM"
          placeholder="Search components"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          disabled={!isTauri() || !rows().length}
          onClick={() => void exportCsv()}
        >
          Export CSV…
        </button>
      </div>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <div class="electrical-scroll">
        <Show
          when={rows().length}
          fallback={<p>No placed components match this view.</p>}
        >
          <div class="electrical-table-wrapper">
            <table class="electrical-table">
            <thead>
              <tr>
                <th class="bom-col-id">ID</th>
                <th class="bom-col-qty">Quantity</th>
                <th class="bom-col-val">Value</th>
                <th class="bom-col-fp">Footprint</th>
                <th class="bom-col-sym">Symbol</th>
                <th class="bom-col-part">Part name</th>
                <th class="bom-col-refs">References</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row, index) => {
                  const first = () => row.members[0].component;
                  const refsText = () =>
                    row.members
                      .map(
                        (m) =>
                          `${filter() === "all" ? `${m.pcbName}:` : ""}${m.component.reference}`,
                      )
                      .join(", ");
                  return (
                    <tr>
                      <td class="bom-col-id">{index() + 1}</td>
                      <td class="bom-col-qty">{row.members.length}</td>
                      <td class="bom-col-val">
                        <BomEditableCell
                          value={first().value}
                          label={`Value for row ${index() + 1}`}
                          onChange={(val) => edit(row.members, "value", val)}
                        />
                      </td>
                      <td class="bom-col-fp">{first().definition.footprint.name}</td>
                      <td class="bom-col-sym">
                        {first().definition.symbol?.name ??
                          "Generic (unresolved)"}
                      </td>
                      <td class="bom-col-part">
                        <BomEditableCell
                          value={first().partName}
                          label={`Part name for row ${index() + 1}`}
                          onChange={(val) => edit(row.members, "partName", val)}
                        />
                      </td>
                      <td class="bom-col-refs">
                        <div class="bom-ref-cell">
                          <span class="bom-ref-text" title={refsText()}>
                            {refsText()}
                          </span>
                          <button
                            type="button"
                            class="bom-ref-btn"
                            aria-label={`References / replace for row ${index() + 1}`}
                            title="References / replace"
                            onClick={() => {
                              setError("");
                              setSelected(
                                row.members.map((m) => m.component.id),
                              );
                              setModalKey(row.key);
                            }}
                          >
                            <ActionIcon name="Open" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
            </table>
          </div>
        </Show>
      </div>

      <Show when={activeModalRow()} keyed>
        {(row) => {
          const first = () => row.members[0].component;
          const title = () =>
            first().value
              ? `${first().value} · ${first().definition.symbol?.name ?? first().definition.footprint.name}`
              : first().definition.symbol?.name ??
                first().definition.footprint.name;
          return (
            <div
              class="overlay overlay--center"
              onClick={(e) => {
                if (e.target === e.currentTarget) setModalKey("");
              }}
            >
              <section
                class="palette bom-references-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`References for ${title()}`}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setModalKey("");
                  }
                }}
              >
                <header class="bom-dialog-header">
                  <h2>
                    References — {title()} ({row.members.length})
                  </h2>
                </header>
                <div class="bom-dialog-content">
                  <Show when={error()}>
                    <p class="pl-error" role="alert">
                      {error()}
                    </p>
                  </Show>
                  <div class="bom-dialog-table-wrap">
                    <table class="bom-dialog-table">
                      <thead>
                        <tr>
                          <th class="col-check">
                            <input
                              type="checkbox"
                              aria-label="Select all references"
                              checked={allSelected()}
                              onChange={(e) =>
                                toggleSelectAll(e.currentTarget.checked)
                              }
                            />
                          </th>
                          <th class="col-pcb">PCB</th>
                          <th class="col-ref">Reference</th>
                          <th class="col-actions">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={row.members}>
                          {(member) => (
                            <tr>
                              <td class="col-check">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${member.component.reference}`}
                                  checked={selected().includes(
                                    member.component.id,
                                  )}
                                  onChange={(e) => {
                                    const id = member.component.id;
                                    setSelected(
                                      e.currentTarget.checked
                                        ? [...selected(), id]
                                        : selected().filter((x) => x !== id),
                                    );
                                  }}
                                />
                              </td>
                              <td class="col-pcb">{member.pcbName}</td>
                              <td class="col-ref">
                                <input
                                  aria-label={`Reference ${member.component.reference}`}
                                  value={member.component.reference}
                                  onChange={(e) =>
                                    edit(
                                      [member],
                                      "reference",
                                      e.currentTarget.value,
                                    )
                                  }
                                />
                              </td>
                              <td class="col-actions">
                                <button
                                  type="button"
                                  class="bom-locate-btn"
                                  onClick={() => {
                                    props.store.visual.activate(member.pcbId);
                                    props.onNavigate?.(member.component.id);
                                    setModalKey("");
                                  }}
                                >
                                  <ActionIcon name="View" />Locate
                                </button>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </div>
                <footer class="bom-dialog-footer">
                  <button
                    type="button"
                    class="bom-replace-btn"
                    disabled={!selected().length || !props.onReplace}
                    onClick={() => {
                      props.onReplace?.(selected());
                      setModalKey("");
                    }}
                  >
                    <ActionIcon name="Settings" />Replace footprint / symbol… ({selected().length} selected)
                  </button>
                  <button
                    type="button"
                    class="type-close"
                    onClick={() => setModalKey("")}
                  >
                    <ActionIcon name="Close" />Close
                  </button>
                </footer>
              </section>
            </div>
          );
        }}
      </Show>
    </section>
  );
}
