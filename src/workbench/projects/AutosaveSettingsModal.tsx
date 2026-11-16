import { ActionIcon } from "../ActionIcon";
import { LibrarySettings } from "../electrical/LibrarySettings";
import { For, Show, createSignal, onMount } from "solid-js";
import {
  MAX_AUTOSAVE_DELAY_MS,
  MIN_AUTOSAVE_DELAY_MS,
  type PlacementStore,
} from "../placement/store";
import type { AutosaveSettings } from "../settings";

const sections = ["General", "Autosave", "Libraries"] as const;
type Section = (typeof sections)[number];

export function AutosaveSettingsModal(props: {
  store: PlacementStore;
  initial: AutosaveSettings;
  theme: "dark" | "light";
  appInfo: string;
  onToggleTheme: () => void;
  restoreFocusTo?: HTMLElement | null;
  onApply: (settings: AutosaveSettings) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = createSignal(props.initial.enabled);
  const [delay, setDelay] = createSignal(String(props.initial.delayMs));
  const [section, setSection] = createSignal<Section>("General");
  const [message, setMessage] = createSignal("");
  let restoreFocus: HTMLElement | null = null;
  let firstTab: HTMLButtonElement | undefined;
  const tabs: HTMLButtonElement[] = [];

  onMount(() => {
    restoreFocus =
      props.restoreFocusTo ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    firstTab?.focus();
  });

  const close = () => {
    props.onClose();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };

  const apply = () => {
    const parsed = Number(delay());
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_AUTOSAVE_DELAY_MS ||
      parsed > MAX_AUTOSAVE_DELAY_MS
    ) {
      setSection("Autosave");
      setMessage(
        `Enter a delay between ${MIN_AUTOSAVE_DELAY_MS} and ${MAX_AUTOSAVE_DELAY_MS} ms.`,
      );
      return;
    }
    setMessage("");
    props.onApply({ enabled: enabled(), delayMs: parsed });
    props.onClose();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };

  return (
    <div
      class="overlay settings-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (
            event.target instanceof HTMLElement &&
            event.target.closest('[role="tablist"]')
          ) {
            const next =
              event.key === "ArrowDown" || event.key === "ArrowRight"
                ? (sections.indexOf(section()) + 1) % sections.length
                : event.key === "ArrowUp" || event.key === "ArrowLeft"
                  ? (sections.indexOf(section()) + sections.length - 1) %
                    sections.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? sections.length - 1
                      : -1;
            if (next >= 0) {
              event.preventDefault();
              setSection(sections[next]);
              tabs[next]?.focus();
              return;
            }
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]):not([tabindex="-1"]),input:not([disabled])',
            ),
          ).filter((item) => !item.closest("[hidden]"));
          const first = items[0],
            last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header class="settings-header">
          <h2>Settings</h2>
          <button aria-label="Close settings" onClick={close}>
            ×
          </button>
        </header>
        <div class="settings-layout">
          <div
            class="settings-nav"
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
          >
            <For each={sections}>
              {(name, index) => (
                <button
                  ref={(element) => {
                    tabs[index()] = element;
                    if (index() === 0) firstTab = element;
                  }}
                  role="tab"
                  id={`settings-tab-${name.toLowerCase()}`}
                  aria-controls={`settings-panel-${name.toLowerCase()}`}
                  aria-selected={section() === name}
                  tabIndex={section() === name ? 0 : -1}
                  onClick={(event) => {
                    setSection(name);
                    event.currentTarget.focus();
                  }}
                >
                  <ActionIcon name={name === "Autosave" ? "Save" : "Settings"} />{name}
                </button>
              )}
            </For>
          </div>
          <div class="settings-content">
            <Show when={section() === "Libraries"}><section id="settings-panel-libraries" role="tabpanel" aria-labelledby="settings-tab-libraries"><LibrarySettings /></section></Show>
            <section
              id="settings-panel-general"
              role="tabpanel"
              aria-labelledby="settings-tab-general"
              tabIndex={0}
              hidden={section() !== "General"}
            >
                <h3>General</h3>
                <label class="settings-field">
                  <span>Color theme</span>
                  <button
                    onClick={props.onToggleTheme}
                    aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} theme`}
                  >
                    <ActionIcon name="Settings" />{props.theme === "dark" ? "Dark" : "Light"}
                  </button>
                </label>
                <p class="settings-about">{props.appInfo}</p>
            </section>
            <section
              id="settings-panel-autosave"
              role="tabpanel"
              aria-labelledby="settings-tab-autosave"
              tabIndex={0}
              hidden={section() !== "Autosave"}
            >
                <h3>Autosave</h3>
                <label class="autosave-toggle">
                  <input
                    type="checkbox"
                    checked={enabled()}
                    onChange={(event) =>
                      setEnabled(event.currentTarget.checked)
                    }
                  />
                  Enable autosave
                </label>
                <label class="settings-field">
                  <span>Autosave delay (ms)</span>
                  <input
                    type="number"
                    min={MIN_AUTOSAVE_DELAY_MS}
                    max={MAX_AUTOSAVE_DELAY_MS}
                    step={100}
                    value={delay()}
                    onInput={(event) => setDelay(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        apply();
                      }
                    }}
                  />
                </label>
                <p class="autosave-helper">500–60000 ms</p>
                <p class="autosave-helper muted">
                  With autosave off, changes stay in memory until you save
                  manually (Ctrl+S).
                </p>
                <Show when={message()}>
                  <p class="autosave-error" role="alert">
                    {message()}
                  </p>
                </Show>
            </section>
          </div>
        </div>
        <footer class="settings-actions">
          <button onClick={close}><ActionIcon name="Cancel" />Cancel</button>
          <button class="settings-apply" onClick={apply}><ActionIcon name="Apply" />
            Apply
          </button>
        </footer>
      </section>
    </div>
  );
}
