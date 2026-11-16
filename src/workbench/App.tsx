import { SchematicPanel } from "./electrical/SchematicPanel";
import { BomPanel } from "./electrical/BomPanel";
import { VisualPanel } from "./visual/VisualPanel";
import { NetsPanel } from "./visual/NetsPanel";
import { ActionIcon } from "./ActionIcon";
import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { getAppInfo } from "../bridge/app-info";
import { createEffect } from "solid-js";
import {
  hasNativeWindow,
  runWindowAction,
  watchMaximized,
  type WindowAction,
} from "../bridge/window";
import { PlacementPanel } from "./placement/PlacementPanel";
import { createPlacementStore } from "./placement/store";
import { hoverSummary } from "./placement/hoverInfo";
import { SaveBadge } from "./SaveBadge";
import { ProjectsPanel } from "./projects/ProjectsPanel";
import { loadRecent } from "./projects/recent";
import { AutosaveSettingsModal } from "./projects/AutosaveSettingsModal";
import {
  loadAutosaveSettings,
  saveAutosaveSettings,
  type AutosaveSettings,
} from "./settings";

const tabs = [
  "Projects",
  "Board mapping",
  "Visual editor",
  "Schematic",
  "BOM",
  "Nets",
];
type Theme = "dark" | "light";
const themeKey = "pcb-re-studio.theme";
function savedTheme(): Theme {
  try {
    return localStorage.getItem(themeKey) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function AboutDialog(props: {
  appInfo: string;
  restoreFocusTo: HTMLElement | null;
  onClose: () => void;
}) {
  let closeButton: HTMLButtonElement | undefined;
  onMount(() => closeButton?.focus());
  const close = () => {
    props.onClose();
    if (props.restoreFocusTo?.isConnected) props.restoreFocusTo.focus();
  };
  return (
    <div
      class="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        class="palette about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="About PCB RE Studio"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button"),
          );
          if (event.shiftKey && document.activeElement === items[0]) {
            event.preventDefault();
            items.at(-1)?.focus();
          } else if (
            !event.shiftKey &&
            document.activeElement === items.at(-1)
          ) {
            event.preventDefault();
            items[0]?.focus();
          }
        }}
      >
        <header class="dialog-header">
          <h2>PCB RE Studio</h2>
        </header>
        <div class="dialog-content">
          <p>{props.appInfo}</p>
        </div>
        <div class="dialog-actions">
          <button ref={closeButton} onClick={close}>
            <ActionIcon name="Close" />
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
export default function App(props: { projectName?: string }) {
  const [status, setStatus] = createSignal("Ready"),
    [activeTab, setActiveTab] = createSignal(0);
  const [theme, setTheme] = createSignal<Theme>(savedTheme());
  const [maximized, setMaximized] = createSignal(false);
  const [autosave, setAutosave] = createSignal(loadAutosaveSettings());
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [appInfo, setAppInfo] = createSignal("PCB RE Studio");
  const [recentProjects, setRecentProjects] = createSignal(loadRecent());
  let settingsInvoker: HTMLElement | null = null;
  let aboutInvoker: HTMLElement | null = null;
  const placement = createPlacementStore();
  const native = hasNativeWindow();
  const tabButtons: HTMLButtonElement[] = [];
  const projectTitle = () => props.projectName || placement.doc()?.name;
  /** Footer text: the canvas hover summary when present, else "Ready" with a
   * project open (save state lives only in the tab-row SaveBadge), else the
   * app-level status. */
  const footerText = () =>
    hoverSummary() ?? (placement.doc() ? "Ready" : status());
  const toggleTheme = () => {
    const next = theme() === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(themeKey, next);
    } catch {
      /* Theme remains usable without storage. */
    }
  };
  const action = (name: WindowAction) => {
    void runWindowAction(name).catch((error: Error) =>
      setStatus(error.message),
    );
  };
  const closeMenus = (restoreFocus = false) => {
    const openMenus = Array.from(
      document.querySelectorAll<HTMLDetailsElement>(
        ".title-menus details[open]",
      ),
    );
    const focusedMenu = openMenus.find((menu) =>
      menu.contains(document.activeElement),
    );
    const summary = focusedMenu?.querySelector<HTMLElement>("summary");
    openMenus.forEach((menu) => menu.removeAttribute("open"));
    if (restoreFocus && summary?.isConnected) summary.focus();
  };
  const closeSiblingMenus = (summary: HTMLElement) => {
    const current = summary.closest("details");
    document
      .querySelectorAll<HTMLDetailsElement>(".title-menus details[open]")
      .forEach((menu) => {
        if (menu !== current) menu.removeAttribute("open");
      });
  };
  const rememberInvoker = (target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    return element?.closest("details")?.querySelector("summary") ?? element;
  };
  const openSettings = (
    target: EventTarget | null = document.activeElement,
  ) => {
    settingsInvoker = rememberInvoker(target);
    setSettingsOpen(true);
  };
  const openAbout = (target: EventTarget | null = document.activeElement) => {
    aboutInvoker = rememberInvoker(target);
    setAboutOpen(true);
  };
  const menuAction = (
    label: string,
    run: (target: HTMLElement) => void,
    disabled = false,
  ) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={(event) => {
        run(event.currentTarget);
        closeMenus();
      }}
    >
      <ActionIcon name={label} />
      {label}
    </button>
  );
  const applyAutosaveSettings = (settings: AutosaveSettings) => {
    setAutosave(settings);
    saveAutosaveSettings(settings);
    placement.configureAutosave(settings);
    setSettingsOpen(false);
  };
  createEffect(() => {
    placement.doc();
    placement.projectPath();
    setRecentProjects(loadRecent());
  });
  onMount(() => {
    placement.configureAutosave(autosave());
    let active = true;
    let unlisten: (() => void) | undefined;
    void getAppInfo()
      .then((info) => {
        if (active) {
          setStatus(info.version);
          setAppInfo(`${info.name} ${info.version}`);
        }
      })
      .catch((error: Error) => {
        if (active) setStatus(error.message);
      });
    void watchMaximized((value) => {
      if (active) setMaximized(value);
    })
      .then((cleanup) => {
        if (active) unlisten = cleanup;
        else cleanup();
      })
      .catch((error: Error) => {
        if (active) setStatus(error.message);
      });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (settingsOpen()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        (activeTab() === 1 || activeTab() === 2) &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !target?.closest(
          "input,textarea,select,[contenteditable],[role='dialog']",
        ) &&
        !document.querySelector("[role='dialog']")
      ) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          if (key === "y" || event.shiftKey) placement.redo();
          else placement.undo();
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (placement.doc()) {
          event.preventDefault();
          void placement.requestSave();
        }
      }
      if (event.key === "Escape") {
        closeMenus(true);
        setAboutOpen(false);
      }
    };
    const outside = (event: PointerEvent) => {
      const menus = document.querySelector(".title-menus");
      if (!(event.target instanceof Node) || !menus?.contains(event.target))
        closeMenus();
    };
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    onCleanup(() => {
      active = false;
      unlisten?.();
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    });
  });
  return (
    <div class="workbench" data-theme={theme()}>
      <header class="titlebar">
        <div class="title-tools">
          <span class="app-symbol" aria-hidden="true">
            ▧
          </span>
          <nav
            class="title-menus"
            aria-label="Application menu"
            onKeyDown={(event) => {
              const menu = (event.target as HTMLElement).closest(
                '[role="menu"]',
              );
              if (
                !menu ||
                !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              )
                return;
              const items = Array.from(
                menu.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              if (!items.length) return;
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (current +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              event.preventDefault();
              items[next].focus();
            }}
          >
            <details>
              <summary
                onClick={(event) => {
                  closeSiblingMenus(event.currentTarget);
                  setRecentProjects(loadRecent());
                }}
              >
                File
              </summary>
              <div role="menu" aria-label="File">
                {menuAction(
                  "New project…",
                  () => void placement.newProjectFlow(),
                  !native,
                )}
                {menuAction(
                  "Open…",
                  () => void placement.openProjectFlow(),
                  !native,
                )}
                {menuAction(
                  "Import project…",
                  () => void placement.importProjectFlow(),
                  !native,
                )}
                <Show when={recentProjects().length > 0}>
                  <div class="menu-heading">Open recent</div>
                  <For each={recentProjects()}>
                    {(entry) =>
                      menuAction(
                        entry.name,
                        () => void placement.openRecentFlow(entry.path),
                        !native,
                      )
                    }
                  </For>
                </Show>
                {menuAction(
                  "Save",
                  () => void placement.requestSave(),
                  !placement.doc(),
                )}
                {menuAction(
                  "Save as…",
                  () => void placement.saveAsFlow(),
                  !native || !placement.doc(),
                )}
                {menuAction(
                  "Export copy…",
                  () => void placement.exportCopyFlow(),
                  !native || !placement.doc(),
                )}
                {menuAction(
                  "Export HTML…",
                  () => void placement.exportHtmlFlow(),
                  !native || !placement.doc(),
                )}
                {menuAction(
                  "Close project",
                  () => void placement.closeProjectFlow(),
                  !placement.doc(),
                )}
                {menuAction(
                  "Delete project…",
                  () => void placement.deleteProjectFlow(),
                  !native || !placement.doc(),
                )}
              </div>
            </details>
            <details>
              <summary
                onClick={(event) => closeSiblingMenus(event.currentTarget)}
              >
                Edit
              </summary>
              <div role="menu" aria-label="Edit">
                {menuAction(
                  "Project details",
                  () => {
                    setActiveTab(0);
                    requestAnimationFrame(() =>
                      document
                        .querySelector<HTMLInputElement>(
                          ".projects-panel input",
                        )
                        ?.focus(),
                    );
                  },
                  !placement.doc(),
                )}
                {menuAction("Autosave settings…", (target) =>
                  openSettings(target),
                )}
              </div>
            </details>
            <details>
              <summary
                onClick={(event) => closeSiblingMenus(event.currentTarget)}
              >
                About
              </summary>
              <div role="menu" aria-label="About">
                {menuAction("About PCB RE Studio", (target) =>
                  openAbout(target),
                )}
              </div>
            </details>
          </nav>
          <button
            onClick={toggleTheme}
            aria-label={`Switch to ${theme() === "dark" ? "light" : "dark"} theme`}
            title="Toggle color theme"
          >
            {theme() === "dark" ? "☼" : "☾"}
          </button>
          <button
            onClick={(event) => openSettings(event.currentTarget)}
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
        <div
          class="window-title"
          title={`PCB RE Studio — ${projectTitle() || "No project open"}`}
          onMouseDown={(event) => {
            if (event.button === 0 && native)
              action(event.detail === 2 ? "toggleMaximize" : "startDragging");
          }}
        >
          PCB RE Studio <span>— {projectTitle() || "No project open"}</span>
        </div>
        <div class="window-controls">
          <button
            disabled={!native}
            aria-label="Minimize"
            title={
              native
                ? "Minimize"
                : "Window controls are available in the desktop app"
            }
            onClick={() => action("minimize")}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1 6h10" />
            </svg>
          </button>
          <button
            disabled={!native}
            aria-label={maximized() ? "Restore" : "Maximize"}
            title={
              native
                ? maximized()
                  ? "Restore"
                  : "Maximize"
                : "Window controls are available in the desktop app"
            }
            onClick={() => action("toggleMaximize")}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <Show
                when={maximized()}
                fallback={<rect x="1.5" y="1.5" width="9" height="9" />}
              >
                <path d="M4 3V1.5h6.5V8H9" />
                <rect x="1.5" y="4" width="6.5" height="6.5" />
              </Show>
            </svg>
          </button>
          <button
            class="window-close"
            disabled={!native}
            aria-label="Close window"
            title={
              native
                ? "Close"
                : "Window controls are available in the desktop app"
            }
            onClick={() => action("close")}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m1.5 1.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </div>
      </header>

      <div class="workspace-tabs">
        <div
          class="workspace-tablist"
          role="tablist"
          aria-label="Workspace tabs"
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (activeTab() + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (activeTab() + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : null;
            if (next !== null) {
              event.preventDefault();
              setActiveTab(next);
              tabButtons[next]?.focus();
              tabButtons[next]?.scrollIntoView?.({
                block: "nearest",
                inline: "nearest",
              });
            }
          }}
        >
          <For each={tabs}>
            {(name, index) => (
              <button
                ref={(element) => {
                  tabButtons[index()] = element;
                }}
                role="tab"
                id={`tab-${index()}`}
                aria-selected={activeTab() === index()}
                aria-controls={`panel-${index()}`}
                tabIndex={activeTab() === index() ? 0 : -1}
                onClick={() => setActiveTab(index())}
              >
                {name}
              </button>
            )}
          </For>
        </div>
        <SaveBadge store={placement} />
      </div>
      <div class="workspace">
        <main>
          <For each={tabs}>
            {(name, index) => (
              <section
                class={`editor-panel${index() === 0 ? " projects-host" : index() === 1 || index() === 2 ? " placement-host" : ""}`}
                id={`panel-${index()}`}
                role="tabpanel"
                aria-labelledby={`tab-${index()}`}
                hidden={activeTab() !== index()}
                tabIndex={0}
              >
                <Show
                  when={index() === 1}
                  fallback={
                    <Show
                      when={index() === 0}
                      fallback={
                        <Show
                          when={index() === 2}
                          fallback={
                            <Show
                              when={index() === 5}
                              fallback={
                                <Show
                                  when={index() === 3}
                                  fallback={
                                    <BomPanel
                                      store={placement}
                                      onNavigate={componentId => {sessionStorage.setItem("electrical-navigation",JSON.stringify({componentId}));setActiveTab(2);}}
                                      onReplace={(ids) => {
                                        sessionStorage.setItem(
                                          "component-replace",
                                          JSON.stringify(ids),
                                        );
                                        setActiveTab(2);
                                      }}
                                    />
                                  }
                                >
                                  <SchematicPanel
                                    store={placement}
                                    active={activeTab() === 3}
                                    onNavigate={componentId => {sessionStorage.setItem("electrical-navigation",JSON.stringify({componentId}));setActiveTab(2);}}
                                    onReplace={(ids) => {
                                      sessionStorage.setItem(
                                        "component-replace",
                                        JSON.stringify(ids),
                                      );
                                      setActiveTab(2);
                                    }}
                                  />
                                </Show>
                              }
                            >
                              <NetsPanel
                                store={placement}
                                onNavigate={() => setActiveTab(2)}
                              />
                            </Show>
                          }
                        >
                          <VisualPanel
                            store={placement}
                            active={activeTab() === 2}
                          />
                        </Show>
                      }
                    >
                      <div class="projects-workspace">
                        <ProjectsPanel
                          store={placement}
                          onOpenSettings={() =>
                            openSettings(document.activeElement)
                          }
                        />
                      </div>
                    </Show>
                  }
                >
                  <PlacementPanel
                    store={placement}
                    onOpenProjectsTab={() => setActiveTab(0)}
                  />
                </Show>
              </section>
            )}
          </For>
        </main>
      </div>
      <footer>
        <span role="status">{footerText()}</span>
      </footer>
      <Show when={aboutOpen()}>
        <AboutDialog
          appInfo={appInfo()}
          restoreFocusTo={aboutInvoker}
          onClose={() => setAboutOpen(false)}
        />
      </Show>
      <Show when={settingsOpen()}>
        <AutosaveSettingsModal
          store={placement}
          initial={autosave()}
          theme={theme()}
          appInfo={appInfo()}
          onToggleTheme={toggleTheme}
          restoreFocusTo={settingsInvoker}
          onApply={applyAutosaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>
    </div>
  );
}
