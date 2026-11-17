import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import type { PlacementStore } from "./placement/store";
import {
  collectPcbIssues,
  issueCategories,
  type IssueReveal,
  type ProjectIssue,
} from "./issues";
import "./issues.css";

export function IssuesBrowser(props: {
  store: PlacementStore;
  onReveal: (request: IssueReveal) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [pcb, setPcb] = createSignal("");
  const [severity, setSeverity] = createSignal("");
  const [expanded, setExpanded] = createSignal<string[]>([]);
  const [notice, setNotice] = createSignal("");
  const pcbs = () => props.store.visual.editor()?.pcbs ?? [];
  const issues = createMemo(() => pcbs().flatMap(collectPcbIssues));
  const filtered = createMemo(() =>
    issues().filter(
      (i) =>
        (!pcb() || i.pcbId === pcb()) &&
        (!severity() || i.severity === severity()),
    ),
  );
  let button!: HTMLButtonElement;
  let token = 0;
  createEffect(() => {
    props.store.projectSession();
    setOpen(false);
    setPcb("");
    setSeverity("");
    setExpanded([]);
    setNotice("");
  });
  const close = () => {
    setOpen(false);
    button?.focus();
  };
  const reveal = (issue: ProjectIssue) => {
    const current = issues().find((i) => i.id === issue.id);
    if (!current?.target) {
      setNotice(
        "This issue no longer has a canvas location. The list has been refreshed.",
      );
      return;
    }
    setOpen(false);
    props.onReveal({
      issue: current,
      session: props.store.projectSession(),
      token: ++token,
    });
  };
  function Dialog() {
    let dialog!: HTMLElement;
    onMount(() => dialog.querySelector<HTMLSelectElement>("select")?.focus());
    return (
      <div
        class="overlay overlay--center"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <section
          ref={dialog}
          class="palette issues-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Project issues"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
            if (e.key !== "Tab") return;
            const items = Array.from(
              dialog.querySelectorAll<HTMLElement>(
                "button:not([disabled]),select:not([disabled])",
              ),
            );
            if (e.shiftKey && document.activeElement === items[0]) {
              e.preventDefault();
              items.at(-1)?.focus();
            } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
              e.preventDefault();
              items[0]?.focus();
            }
          }}
        >
          <header class="dialog-header">
            <h2>Project issues</h2>
            <span>{issues().length} total</span>
          </header>
          <div class="dialog-content issues-content">
            <div class="issues-filters">
              <label>
                PCB{" "}
                <select
                  value={pcb()}
                  onChange={(e) => setPcb(e.currentTarget.value)}
                >
                  <option value="">All PCBs</option>
                  <For each={pcbs()}>
                    {(p) => <option value={p.id}>{p.name}</option>}
                  </For>
                </select>
              </label>
              <label>
                Severity{" "}
                <select
                  value={severity()}
                  onChange={(e) => setSeverity(e.currentTarget.value)}
                >
                  <option value="">All severities</option>
                  <For each={["Error", "Warning", "Unfinished"]}>
                    {(s) => <option>{s}</option>}
                  </For>
                </select>
              </label>
              <span>{filtered().length} shown</span>
            </div>
            <Show when={notice()}>
              <p role="status">{notice()}</p>
            </Show>
            <Show when={!issues().length}>
              <p>No detected issues or unfinished work.</p>
            </Show>
            <Show when={issues().length && !filtered().length}>
              <p>No issues match these filters.</p>
            </Show>
            <For each={issueCategories}>
              {(category, index) => {
                const rows = createMemo(() =>
                  filtered().filter((i) => i.category === category),
                );
                const isOpen = () => expanded().includes(category);
                return (
                  <section class="issue-category">
                    <button
                      class="issue-category-toggle"
                      aria-expanded={isOpen()}
                      aria-controls={`issue-category-${index()}`}
                      onClick={() =>
                        setExpanded((old) =>
                          isOpen()
                            ? old.filter((c) => c !== category)
                            : [...old, category],
                        )
                      }
                    >
                      <strong>
                        {isOpen() ? "▾" : "▸"} {category} ({rows().length})
                      </strong>
                      <span>
                        {["Error", "Warning", "Unfinished"]
                          .map(
                            (s) =>
                              `${rows().filter((i) => i.severity === s).length} ${s.toLowerCase()}`,
                          )
                          .join(" · ")}
                      </span>
                    </button>
                    <div id={`issue-category-${index()}`} hidden={!isOpen()}>
                      <ul class="issues-list">
                        <For each={rows()}>
                          {(i) => (
                            <li>
                              <div>
                                <span
                                  class={`issue-severity issue-${i.severity.toLowerCase()}`}
                                >
                                  {i.severity}
                                </span>
                                <strong>{i.pcbName}</strong>
                                <p>{i.message}</p>
                              </div>
                              <Show when={i.target}>
                                <button
                                  onClick={() => reveal(i)}
                                  aria-label={`Show on canvas: ${i.message}`}
                                >
                                  Show on canvas
                                </button>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                      <Show when={!rows().length}>
                        <p>No issues in this category.</p>
                      </Show>
                    </div>
                  </section>
                );
              }}
            </For>
          </div>
          <footer class="type-dialog-footer">
            <button onClick={close}>Close</button>
          </footer>
        </section>
      </div>
    );
  }
  return (
    <>
      <button
        ref={button}
        class="issues-button"
        disabled={!props.store.doc()}
        aria-haspopup="dialog"
        onClick={() => {
          setNotice("");
          setOpen(true);
        }}
      >
        Issues ({issues().length})
      </button>
      <Show when={open()}>
        <Dialog />
      </Show>
    </>
  );
}
