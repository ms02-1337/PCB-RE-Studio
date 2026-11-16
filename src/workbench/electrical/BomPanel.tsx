import { createMemo, createSignal, For, Show } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { kicad } from "../../bridge/kicad";
import type { PlacementStore } from "../placement/store";
import type { ElectricalComponent } from "./model";
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

export function BomPanel(props: {
  store: PlacementStore;
  onNavigate?: (componentId: string) => void;
  onReplace?: (ids: string[]) => void;
}) {
  const [filter, setFilter] = createSignal("active");
  const [query, setQuery] = createSignal("");
  const [expanded, setExpanded] = createSignal("");
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
        <label>
          PCB scope{" "}
          <select
            value={filter()}
            onChange={(e) => {
              setFilter(e.currentTarget.value);
              setExpanded("");
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
          <table class="electrical-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Quantity</th>
                <th>Value</th>
                <th>Footprint</th>
                <th>Symbol</th>
                <th>Part name</th>
                <th>References</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row, index) => {
                  const first = () => row.members[0].component;
                  return (
                    <>
                      <tr>
                        <td>{index() + 1}</td>
                        <td>{row.members.length}</td>
                        <td>
                          <input
                            aria-label={`Value for row ${index() + 1}`}
                            value={first().value}
                            onChange={(e) =>
                              edit(row.members, "value", e.currentTarget.value)
                            }
                          />
                        </td>
                        <td>{first().definition.footprint.name}</td>
                        <td>
                          {first().definition.symbol?.name ??
                            "Generic (unresolved)"}
                        </td>
                        <td>
                          <input
                            aria-label={`Part name for row ${index() + 1}`}
                            value={first().partName}
                            onChange={(e) =>
                              edit(
                                row.members,
                                "partName",
                                e.currentTarget.value,
                              )
                            }
                          />
                        </td>
                        <td>
                          {row.members
                            .map(
                              (m) =>
                                `${filter() === "all" ? `${m.pcbName}:` : ""}${m.component.reference}`,
                            )
                            .join(", ")}
                        </td>
                        <td>
                          <button
                            aria-expanded={expanded() === row.key}
                            onClick={() => {
                              setExpanded(
                                expanded() === row.key ? "" : row.key,
                              );
                              setSelected(
                                row.members.map((m) => m.component.id),
                              );
                            }}
                          >
                            References / replace
                          </button>
                        </td>
                      </tr>
                      <Show when={expanded() === row.key}>
                        <tr>
                          <td colspan="8">
                            <div class="bom-members">
                              <For each={row.members}>
                                {(member) => (
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={selected().includes(
                                        member.component.id,
                                      )}
                                      onChange={(e) =>
                                        setSelected(
                                          e.currentTarget.checked
                                            ? [
                                                ...selected(),
                                                member.component.id,
                                              ]
                                            : selected().filter(
                                                (id) =>
                                                  id !== member.component.id,
                                              ),
                                        )
                                      }
                                    />
                                    {member.pcbName}
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
                                    <button
                                      onClick={() => {
                                        props.store.visual.activate(
                                          member.pcbId,
                                        );
                                        props.onNavigate?.(member.component.id);
                                      }}
                                    >
                                      Locate
                                    </button>
                                  </label>
                                )}
                              </For>
                              <button
                                disabled={
                                  !selected().length || !props.onReplace
                                }
                                onClick={() => props.onReplace?.(selected())}
                              >
                                Replace footprint / symbol…
                              </button>
                            </div>
                          </td>
                        </tr>
                      </Show>
                    </>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </section>
  );
}
