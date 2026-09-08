import type { Terminal } from '@xterm/xterm';
import { UNDO_WINDOW_MS, UndoStack, offerLabel, type UndoOffer } from './undo-offers.js';
import type {
  LayoutNode,
  MergeableSession,
  ResolvedPath,
  ResumableAgentSession,
  SavedItem,
  ServerMessage,
  TitleFields,
} from '@tabterm/shared';
import { linesWithContent } from './screen-content.js';
import { InputLine, rowsNeeded } from './input-line.js';
import { DaemonClient, type ConnectionStatus } from '../transport/daemon-client.js';
import { getToken } from '../transport/token.js';
import { daemonPort } from '../transport/port.js';
import { SplitView, collectPanes } from '../layout/split-view.js';
import { PaneHost } from './panes.js';
import { PaneChooser } from './pane-chooser.js';
import { openLabelForm } from './label-form.js';
import { describeError } from './describe-error.js';
import type { PaneMenuAction } from './xterm-controller.js';
import { findCandidates } from './path-links.js';
import { TypedBuffer, backspaces } from './hotstrings.js';
import { chooseOpenAction, describeOpen } from './open-action.js';
import { needsAttention, StatusMachine, titleStatus } from './status-machine.js';
import { describeTime, isLongRunning, type TimeState } from './elapsed.js';
import { applyFavicon, composeTitle, drawFavicon, type FaviconState } from './titles.js';
import { TabFlasher, flashingSessions, setFlashing } from './flash-on-finish.js';
import { Launcher } from '../launcher/launcher.js';
import { CommandPanel } from '../launcher/panel-view.js';
import { DEFAULT_PLACEMENT, type PanelPlacement } from '../launcher/command-panel.js';
import { buildSettings } from '../launcher/settings-view.js';
import { buildReset, buildResetDone } from '../launcher/reset-view.js';
import { quotePath } from './quote-path.js';
import { DEFAULT_THEME, themeNamed } from './themes.js';
import { DEFAULT_COLOR, loadRecentColors, rememberColor, type ColorUse } from './color-store.js';
import {
  describeAction,
  loadActions,
  saveActions,
  type CustomAction,
} from '../launcher/custom-actions.js';
import {
  DEFAULT_PAGE_SHORTCUTS,
  describeKeys,
  actionIdFrom,
  actionShortcutId,
  loadShortcuts,
  prettyKeys,
  saveShortcuts,
  whyNot,
  type PageShortcut,
} from './page-shortcuts.js';
import {
  alteredDefaults,
  defaultsOutOfOrder,
  loadTemplates,
  saveTemplates,
  withDefaultsRestored,
  type LayoutTemplate,
} from '../launcher/templates.js';
import type {
  AgentHooksStatus,
  LiveSession,
  NotifyPolicy,
  ShellIntegrationStatus,
} from '@tabterm/shared';
import { distinctSizes, HISTORY_MS, isResizeStorm, recordChange } from './resize-storm.js';
import { fillMenu, menuShell, placeAndArm, type ShellItem } from './menu-shell.js';
import { shouldRedrawAfterAway } from './wake-redraw.js';
import { buildStats } from '../launcher/stats-view.js';
import { SessionStats } from '../launcher/session-stats.js';
import { Palette, type PaletteAction } from '../launcher/palette.js';

/**
 * A terminal tab, which is really a workspace of one or more panes.
 *
 * A standalone terminal is a workspace with a single pane, so splitting is not a mode switch:
 * the same code path renders one pane or six. See docs/03-data-model.md §2.
 *
 * Attaching is deferred until the tab is actually looked at, because Chrome restores every tab
 * at once at startup and eager attach means N snapshot replays competing.
 * See docs/04-session-lifecycle.md §5.
 */

const params = new URLSearchParams(location.search);

/**
 * Whether this page is reattaching to a workspace that already exists.
 *
 * The start panel belongs to a *new* tab: it is drawn over an empty terminal because there is
 * no output yet. A page that opened with a workspace in its URL is not that. It is a session
 * somebody already has, most often because they reloaded, and it may have a screen full of
 * output -- which used to end up crammed into the small strip the panel leaves behind.
 *
 * Read once at load, because the URL gains a workspace id as soon as a session is created and
 * would otherwise stop telling the two cases apart.
 */
const reattaching = params.has('workspace');
/** Opened from the toolbar icon's settings entry, so the panel starts on that pane. */
const openPanelAt = params.get('panel');

const root = document.getElementById('terminal') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const recoveryEl = document.getElementById('recovery') as HTMLElement;

let client: DaemonClient | null = null;
/** Which daemon this tab is talking to, so a test can tell its own from somebody's real one. */
let connectedPort = 0;
let panesHost: PaneHost | null = null;
let splitView: SplitView | null = null;
let launcher: Launcher | null = null;
let palette: Palette | null = null;
let savedItems: SavedItem[] = [];
let mergeable: MergeableSession[] = [];

let workspaceId = params.get('workspace') ?? '';
let layout: LayoutNode | null = null;
let attached = false;

let titleFields: TitleFields = {};
let faviconState: FaviconState = 'disconnected';
/** A tab has one favicon, so many panes reduce to the most urgent state among them. */
const paneStatus = new StatusMachine();
/**
 * Daemon-owned settings, mirrored here for the settings pane to render.
 *
 * Null until it answers, which the pane says rather than guessing at a default and showing a
 * switch in a position the daemon might disagree with.
 */
let notifyPolicy: NotifyPolicy | null = null;
let agentHooks: AgentHooksStatus | null = null;
let shellIntegration: ShellIntegrationStatus | null = null;
let scrollbackBytes: number | null = null;
let backgroundTimeout: number | null | undefined;
/**
 * Something was asked for from this tab's start screen, so what it creates belongs here.
 *
 * Set by every start-screen action that makes a workspace: a layout, a project template, and
 * resuming an agent. A tab showing a list of ways to begin is empty by definition, and choosing
 * one of them means "begin here". Opening a second tab left this one sitting on the menu beside
 * the thing it had just started, which is a tab nobody wanted.
 */
let layoutRequestedHere = false;

/**
 * Whether the question "is this tab empty?" can be answered yet.
 *
 * False until a reattaching tab has had time to restore its screen. Until then every tab looks
 * empty, and drawing the start screen on that basis is what made it flash up and vanish.
 */
let startScreenDecided = !reattaching;
/** A template whose commands are waiting for its panes to exist. */
let pendingTemplate: LayoutTemplate | null = null;
/** Everything running that this tab is not already showing, for the start screen and the panes. */
let liveElsewhere: readonly LiveSession[] = [];
/** Actions somebody made, which sit in the command menu beside the ones that ship. */
let customActions: CustomAction[] = [];
/** The keys this page answers to, which are settings rather than facts about the code. */
let pageShortcuts: PageShortcut[] = [];
/**
 * What "launch an agent" runs, as the daemon last said. Null until it has answered.
 *
 * Kept here so the settings box can show it, and so a change made in another tab arrives rather
 * than leaving this one showing what was true when it opened.
 */
let agentCommand: string | null = null;

/** This tab was opened by "launch an agent", and is waiting to be told what that means. */
let launchAgentOnOpen = false;

/** Kept so an action naming a template can say which one, without a lookup per keystroke. */
let knownTemplates: readonly LayoutTemplate[] = [];

/**
 * Read the bindings again, now that what can be bound may have changed.
 *
 * The list is the shipped shortcuts plus one row per action somebody made, so it has to be
 * rebuilt whenever the actions change as well as whenever the keys do.
 */
async function refreshShortcuts(): Promise<void> {
  pageShortcuts = await loadShortcuts(customActions.map((a) => ({ id: a.id, name: a.name })));
  commandPanel?.refreshSettings();
  palette?.setActions(paletteActions());
}

/**
 * Actions, shortcuts and templates are one setting shared by every tab, so every tab follows.
 *
 * Making an action in one tab and finding it missing in the one beside it is the kind of thing
 * that reads as the product having lost it. Storage tells us what changed, which is cheaper than
 * re-reading everything and is also the only way to know that another tab is what changed it.
 */
function watchSharedSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('tabterm.actions' in changes) {
      void loadActions().then(async (actions) => {
        customActions = actions;
        await refreshShortcuts();
        commandPanel?.render();
      });
      return;
    }
    if ('tabterm.pageShortcuts' in changes) void refreshShortcuts();
    if ('tabterm.templates' in changes) {
      void loadTemplates().then((templates) => {
        knownTemplates = templates;
        launcher?.setTemplates(templates);
        alteredTemplateCount = countToRestore(templates);
        commandPanel?.refreshSettings();
      });
    }
  });
}

/**
 * What a custom action does when it is chosen.
 *
 * Two kinds, and each is expressed in terms of something the product already does rather than in
 * a path of its own: a template opens the way the start screen opens it, and a command runs in a
 * pane the way anything else runs in a pane.
 */
/**
 * The form for an action, for a new one or one being edited.
 *
 * Deliberately the same shape as the template form: a name, a description, and the one thing
 * that differs. Two dialogs for two kinds of saved thing would drift, and somebody who has made
 * a template already knows how this works.
 */
/** Open the form for one somebody made. Both the palette and the command panel call this. */
function editAction(id: string): void {
  const action = customActions.find((a) => a.id === id);
  if (action) showActionForm(action);
}

/**
 * Delete one, and the key bound to it with it.
 *
 * Leaving the binding behind would leave a combination claimed by something that no longer
 * exists, which blocks it for everything else and does nothing when pressed.
 */
function deleteAction(id: string): void {
  void (async () => {
    customActions = customActions.filter((a) => a.id !== id);
    await saveActions(customActions);
    pageShortcuts = pageShortcuts.filter((k) => k.id !== actionShortcutId(id));
    await saveShortcuts(pageShortcuts);
    await refreshShortcuts();
    commandPanel?.render();
  })();
}

function showActionForm(existing?: CustomAction): void {
  document.querySelector('.template-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'template-backdrop';
  const form = document.createElement('div');
  form.className = 'template-dialog';
  backdrop.append(form);

  const title = document.createElement('div');
  title.className = 'template-title';
  title.textContent = existing ? 'Edit action' : 'New action';
  form.append(title);

  const name = document.createElement('input');
  name.className = 'launcher-input';
  name.placeholder = 'Name, such as "agent here" or "run the tests"';
  name.spellcheck = false;
  name.value = existing?.name ?? '';

  const description = document.createElement('input');
  description.className = 'launcher-input';
  description.placeholder = 'What it is for (optional)';
  description.spellcheck = false;
  description.value = existing?.description ?? '';

  const kind = document.createElement('select');
  for (const [value, label] of [
    ['command', 'Run a command'],
    ['template', 'Open a template'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    kind.append(option);
  }
  kind.value = existing?.kind ?? 'command';

  const command = document.createElement('input');
  command.className = 'launcher-input';
  command.placeholder = 'The command, such as claude';
  command.spellcheck = false;
  command.value = existing?.command ?? '';

  const template = document.createElement('select');
  for (const t of knownTemplates) {
    const option = document.createElement('option');
    option.value = t.id;
    option.textContent = t.name;
    template.append(option);
  }
  if (existing?.templateId) template.value = existing.templateId;

  const where = document.createElement('select');
  for (const [value, label] of [
    ['new-tab', 'In a new tab'],
    ['split', 'Beside this pane'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    where.append(option);
  }
  where.value = existing?.where ?? 'new-tab';

  // Only the field that belongs to the chosen kind, so the form never asks for both.
  const showRelevant = (): void => {
    const isCommand = kind.value === 'command';
    command.hidden = !isCommand;
    where.hidden = !isCommand;
    template.hidden = isCommand;
  };
  kind.addEventListener('change', showRelevant);
  showRelevant();

  /**
   * The key this action answers to, bound here as well as in the settings panel.
   *
   * Here because this is where somebody is already thinking about the action, and there because
   * that is where every other key lives and where you look when you have forgotten one. Both
   * write to the same store, so neither is a second copy of the truth.
   */
  const shortcutRow = document.createElement('div');
  shortcutRow.className = 'template-shortcut';
  const shortcutLabel = document.createElement('span');
  shortcutLabel.className = 'set-label';
  shortcutLabel.textContent = 'Shortcut';
  const shortcutButton = document.createElement('button');
  shortcutButton.className = 'launcher-chip';
  const idForKeys = actionShortcutId(existing?.id ?? '');
  let chosenKeys = existing ? (pageShortcuts.find((k) => k.id === idForKeys)?.keys ?? '') : '';
  const problem = document.createElement('span');
  problem.className = 'set-desc set-key-problem';
  const drawKeys = (): void => {
    shortcutButton.textContent = prettyKeys(chosenKeys);
  };
  drawKeys();
  /**
   * A way to have no key at all, beside the one that records one.
   *
   * Recording was the only thing offered, so a key could be changed and never removed.
   */
  const clearKeys = document.createElement('button');
  clearKeys.className = 'launcher-chip';
  clearKeys.textContent = 'Clear';
  clearKeys.title = 'Leave this action with no shortcut';
  clearKeys.addEventListener('click', (e) => {
    e.preventDefault();
    chosenKeys = '';
    problem.textContent = '';
    drawKeys();
  });

  shortcutButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (shortcutButton.dataset['recording'] === 'yes') return;
    shortcutButton.dataset['recording'] = 'yes';
    shortcutButton.textContent = 'Press the keys, Escape to leave it, Backspace to clear it';
    problem.textContent = '';
    const onKey = (event: KeyboardEvent): void => {
      /**
       * Stopped here and nowhere else, while a key is being recorded.
       *
       * Escape closes this form, which is right except in the middle of this: pressing it to say
       * "leave the shortcut alone" closed the whole thing and lost what had been typed into it.
       * `stopImmediatePropagation` because this runs at the capture phase and another listener
       * on the same element would otherwise still see it.
       */
      event.preventDefault();
      event.stopImmediatePropagation();
      // A modifier on its own is somebody still reaching for the rest of the combination.
      if (['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) return;
      document.removeEventListener('keydown', onKey, true);
      delete shortcutButton.dataset['recording'];
      if (event.key === 'Escape') {
        drawKeys();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        chosenKeys = '';
        problem.textContent = '';
        drawKeys();
        return;
      }
      const pressed = describeKeys(event);
      const refused = whyNot(pressed);
      if (refused !== null) {
        problem.textContent = refused;
        drawKeys();
        return;
      }
      const clash = pageShortcuts.find((k) => k.id !== idForKeys && k.keys === pressed);
      if (clash) {
        problem.textContent = `Already used by "${clash.title}".`;
        drawKeys();
        return;
      }
      chosenKeys = pressed;
      problem.textContent = '';
      drawKeys();
    };
    document.addEventListener('keydown', onKey, true);
  });
  /**
   * What not to try, said before somebody spends a minute finding out.
   *
   * A key Chrome keeps never reaches this page at all, and one another extension has claimed
   * reaches it after that extension has already acted. Both are refused when they are pressed,
   * and being told in advance is worth a line.
   */
  const caution = document.createElement('div');
  caution.className = 'set-desc';
  caution.textContent =
    'Chrome keeps combinations like Command W, Command T and Command L for itself, and another ' +
    'extension may already use one. Those are refused here rather than bound to nothing.';

  shortcutRow.append(shortcutLabel, shortcutButton, clearKeys, problem);

  form.append(name, description, kind, command, where, template, shortcutRow, caution);

  const row = document.createElement('div');
  row.className = 'template-actions';
  const save = document.createElement('button');
  save.className = 'launcher-chip is-selected';
  save.textContent = existing ? 'Save changes' : 'Save action';
  const cancel = document.createElement('button');
  cancel.className = 'launcher-chip';
  cancel.textContent = 'Cancel';
  row.append(save, cancel);
  form.append(row);

  const close = (): void => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  save.addEventListener('click', () => {
    const label = name.value.trim();
    if (label === '') {
      name.focus();
      return;
    }
    const isCommand = kind.value === 'command';
    if (isCommand && command.value.trim() === '') {
      command.focus();
      return;
    }
    if (!isCommand && template.value === '') {
      template.focus();
      return;
    }
    const next: CustomAction = {
      // The same id when editing, so it keeps its place in the list.
      id: existing?.id ?? `a-${String(Date.now())}`,
      name: label,
      kind: isCommand ? 'command' : 'template',
      where: where.value === 'split' ? 'split' : 'new-tab',
      ...(description.value.trim() === '' ? {} : { description: description.value.trim() }),
      ...(isCommand ? { command: command.value.trim() } : { templateId: template.value }),
    };
    void (async () => {
      const at = customActions.findIndex((a) => a.id === next.id);
      customActions =
        at >= 0
          ? customActions.map((a) => (a.id === next.id ? next : a))
          : [...customActions, next];
      await saveActions(customActions);
      // The binding, under this action's id. A new action has none until it has an id, which is
      // why this is written after the action itself rather than while the form is open.
      const bindingId = actionShortcutId(next.id);
      const withoutOld = pageShortcuts.filter((k) => k.id !== bindingId);
      pageShortcuts =
        chosenKeys === ''
          ? withoutOld
          : [...withoutOld, { id: bindingId, title: next.name, keys: chosenKeys }];
      await saveShortcuts(pageShortcuts);
      await refreshShortcuts();
      commandPanel?.render();
      close();
    })();
  });

  document.body.append(backdrop);
  name.focus();
}

function runCustomAction(action: CustomAction): void {
  if (action.kind === 'template') {
    const template = knownTemplates.find((t) => t.id === action.templateId);
    if (!template) {
      setStatus('That action names a template that is gone', 'warn');
      setTimeout(() => setStatus('', 'hidden'), 3000);
      return;
    }
    pendingTemplate = template;
    layoutRequestedHere = true;
    const size = panesHost?.fit(splitView?.focused ?? '') ?? attachSize();
    client?.send({
      t: 'create-layout',
      path: currentCwd || template.path,
      panes: template.panes,
      direction: 'horizontal',
      shape: template.shape,
      ...(template.layout ? { layout: template.layout } : {}),
      createIfMissing: true,
      ...size,
    });
    return;
  }

  const command = action.command ?? '';
  if (command === '') return;
  if (action.where === 'new-tab') {
    /**
     * The command travels in session storage, not in the URL.
     *
     * A URL that runs a command is a URL that runs a command whoever opens it. Nothing on the
     * web can reach an extension page today, because none of these are web accessible, but that
     * is a manifest line away from being untrue and this file would not be the one anybody
     * changed. The `staged` parameter next to this one deliberately asks before running, and
     * two ways of arriving with a command should not disagree about that.
     *
     * A one-shot key instead: written here, read once by the tab that was opened for it, and
     * removed. It cannot be guessed, it cannot be reused, and it does not survive the browser.
     */
    const ticket = `run-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
    void chrome.storage.session
      .set({ [ticket]: command })
      .then(() =>
        chrome.tabs.create({
          url: `${chrome.runtime.getURL('terminal.html')}?ticket=${encodeURIComponent(ticket)}`,
          active: true,
        }),
      )
      .catch(() => {
        /* Session storage is unavailable in some contexts. Then no tab, rather than a bad one. */
      });
    return;
  }
  // Beside this pane: split, then let the new pane's own prompt receive it.
  splitFocused('horizontal');
  expectPane(command);
}

/**
 * A command waiting for the pane a split is about to produce.
 *
 * Bounded in time, because a split that never arrives would otherwise leave this set and the
 * command would run in whatever pane appeared next, minutes later and for no visible reason. A
 * command that missed its pane is better dropped than delivered somewhere else.
 */
let pendingSplitCommand: string | null = null;
let pendingSplitTimer: ReturnType<typeof setTimeout> | undefined;

function expectPane(command: string): void {
  pendingSplitCommand = command;
  clearTimeout(pendingSplitTimer);
  pendingSplitTimer = setTimeout(() => {
    pendingSplitCommand = null;
  }, 15_000);
}

function takePendingCommand(): string | null {
  const command = pendingSplitCommand;
  pendingSplitCommand = null;
  clearTimeout(pendingSplitTimer);
  return command;
}
/** How many shipped templates have been deleted or changed, so settings can offer to restore. */
let alteredTemplateCount = 0;

/**
 * How many shipped templates are not as they shipped, order included.
 *
 * Order counts because the first four carry Control and a number, so a list in a different order
 * is a different set of keys. Dragging them around is a deliberate act and this only offers to
 * put them back; it never does it on its own.
 */
function countToRestore(current: readonly LayoutTemplate[]): number {
  const altered = alteredDefaults(current).length;
  return altered > 0 ? altered : defaultsOutOfOrder(current) ? 1 : 0;
}

/**
 * Per-pane timing, driven entirely by discrete events from the daemon.
 *
 * The label is recomputed locally at 1 Hz while visible and not at all while hidden, because a
 * hidden tab throttles timers anyway and nobody is reading it. See docs/11-performance.md §6.
 */
const paneTime = new Map<string, TimeState>();
let timeTimer: number | undefined;

function timeStateFor(paneId: string): TimeState {
  let state = paneTime.get(paneId);
  if (!state) {
    state = {};
    paneTime.set(paneId, state);
  }
  return state;
}

function renderTimeLabels(): void {
  for (const pane of panesHost?.all ?? []) {
    const text = describeTime(timeStateFor(pane.paneId));
    const wrapper = pane.element.parentElement;
    if (!wrapper) continue;
    let label = wrapper.querySelector('.pane-time');
    if (!text) {
      label?.remove();
      continue;
    }
    if (!label) {
      label = document.createElement('div');
      label.className = 'pane-time';
      wrapper.append(label);
    }
    label.textContent = text;
  }
}

function startTimeTicking(): void {
  clearInterval(timeTimer);
  timeTimer = undefined;
  renderTimeLabels();
  if (document.visibilityState !== 'visible') return;
  // Once per second is the fastest a human reads a duration, and no faster than the display
  // can meaningfully change.
  timeTimer = window.setInterval(renderTimeLabels, 1000);
}

function stopTimeTicking(): void {
  clearInterval(timeTimer);
  timeTimer = undefined;
}
let animPhase = 0;
let animTimer: number | undefined;

/**
 * Resolved paths.
 *
 * A RELATIVE path means something different in every directory, so its key includes the
 * directory it was resolved against. Absolute and home-relative paths stand on their own.
 */
const pathCache = new Map<string, ResolvedPath>();
const pathsInFlight = new Set<string>();
let currentCwd = '';

/** Links are inert unless Command is held, so ordinary text selection stays safe. */
let cmdHeld = false;

// ---------------------------------------------------------------------------
// Chrome-facing surface
// ---------------------------------------------------------------------------

function setStatus(text: string, tone: 'ok' | 'warn' | 'error' | 'hidden'): void {
  statusEl.textContent = text;
  statusEl.dataset['tone'] = tone;
  statusEl.hidden = tone === 'hidden';
}

function refreshTitle(status?: string): void {
  const count = layout ? collectPanes(layout).length : 1;
  /**
   * The facts a title is made from, gathered here because this is where they are known.
   *
   * The composer is given what the tab holds rather than a string, so there is one rule for what
   * a tab is called and it lives in one file.
   */
  const fields = {
    ...titleFields,
    paneCount: count,
    ...(launcher && !launcher.dismissed ? { startScreen: true } : {}),
    ...(openedTemplate && openedTemplatePanes === count ? { template: openedTemplate } : {}),
    ...(lastCommandHere ? { lastCommand: lastCommandHere } : {}),
  };
  // With several panes the interesting thing is what needs attention, not the pane count.
  document.title = composeTitle(fields, status ?? titleStatus(paneStatus, count));
}

/**
 * The template this tab was opened from, and how many panes it had.
 *
 * Both, because a layout stops being that template the moment a pane is closed: an arrangement
 * of two is not the four-pane thing somebody opened, and calling it by that name would be a
 * title that has quietly stopped being true.
 */
let openedTemplate: string | null = null;
let openedTemplatePanes = 0;
/** The last command run in this tab, whose first words are what a tab strip can show. */
let lastCommandHere = '';

/**
 * A way back from a clear, for a few seconds.
 *
 * Clearing is a reflex, and a reflex that can destroy an hour of output needs a way back. The
 * durable copies are already gone by the time this appears, so undo restores only what this tab
 * still had in memory, which is the compromise that keeps clearing honest.
 */
let clearUndoTimer: number | undefined;

/**
 * Panes whose clear has not finished happening yet.
 *
 * Clearing writes `Ctrl+L` to the shell so the prompt comes back, and the shell's redraw arrives
 * whenever it arrives. Until it does, the screen is mid-clear: putting the old text back before
 * that redraw lands means the redraw wipes it, and the undo appears to have done nothing.
 *
 * Nobody hit this by hand, because a person takes longer to reach for the button than a shell
 * takes to redraw. A check that waits for the button rather than sleeping is faster than a
 * person, and it found it.
 */
const clearSettling = new Set<string>();

/**
 * When each pane was cleared by us, so the clear's own aftermath is not mistaken for new work.
 *
 * Clearing asks the shell to redraw by writing `Ctrl+L` to it, and the shell integration reports
 * what the shell runs. So the clear announces a command start of its own, and the offer to undo
 * is taken away the instant it appears, by the thing that was supposed to make the screen look
 * normal again. That is "undo clear doesn't work if clear is done with cmd shift k", and it is
 * why it looked intermittent: on a quick machine the offer is seen and pressed first.
 */
const clearedAt = new Map<string, number>();
const CLEAR_AFTERMATH_MS = 1500;

function offerClearUndo(paneId: string): void {
  const button = document.getElementById('clear-undo');
  if (!(button instanceof HTMLButtonElement)) return;
  clearTimeout(clearUndoTimer);
  /**
   * Offered at once, and armed when the clear has settled.
   *
   * Shown immediately because a control that appears late is a control nobody finds. Pressing it
   * during the moment the shell is still redrawing re-runs itself once that redraw lands, rather
   * than writing into a screen that is about to be wiped.
   */
  clearSettling.add(paneId);
  clearedAt.set(paneId, Date.now());
  // A shell that prints nothing back must not leave this armed forever.
  setTimeout(() => clearSettling.delete(paneId), 1500);
  button.hidden = false;
  const apply = (): void => {
    if (clearSettling.has(paneId)) {
      // The shell is still redrawing. Wait for that to land, then do exactly this.
      setTimeout(apply, 40);
      return;
    }
    const pane = panesHost?.get(paneId);
    const text = pane?.controller.takeUndo() ?? '';
    /**
     * Written **over** the prompt, not after it.
     *
     * Clearing ends with the shell redrawing its prompt at the top of the screen, so appending
     * here put the restored screen to the right of a live prompt and left a second copy of that
     * prompt above everything. The restored text ends with the prompt line the shell drew before
     * the clear, which is the same text at the same column, so overwriting the line puts the
     * cursor exactly where the shell already believes it is.
     */
    if (text) {
      const toLineStart = `\r${String.fromCharCode(27)}[2K`;
      pane?.controller.write(new TextEncoder().encode(toLineStart + text), () => {});
    }
    dismissClearUndo(paneId);
  };
  button.onclick = apply;
  // Ten seconds, and gone the moment anything else is run: an undo offered over new output
  // would put the old screen underneath the new one.
  clearUndoTimer = window.setTimeout(() => dismissClearUndo(paneId), 10_000);
}

/**
 * Command+Z, while the undo is being offered.
 *
 * The same action as the button, reached the way undo is reached everywhere else. The offer is
 * already bounded to ten seconds and to "nothing has run since", so this borrows those limits
 * rather than inventing its own: outside that window the key is not ours and goes to the shell,
 * where Command+Z means nothing anyway.
 */
function undoClearIfOffered(): boolean {
  const button = document.getElementById('clear-undo');
  if (!(button instanceof HTMLButtonElement) || button.hidden) return false;
  button.click();
  return true;
}

function dismissClearUndo(paneId?: string): void {
  clearTimeout(clearUndoTimer);
  clearUndoTimer = undefined;
  const button = document.getElementById('clear-undo');
  if (button instanceof HTMLButtonElement) button.hidden = true;
  if (paneId) panesHost?.get(paneId)?.controller.forgetUndo();
}

/**
 * Ask before ending everything.
 *
 * Replaces the whole page rather than opening a dialog over a terminal: this tab exists only to
 * ask the question, and a confirmation drawn over a working terminal invites answering it while
 * looking at something else.
 */
function showResetConfirmation(sessions: readonly LiveSession[]): void {
  void chrome.runtime.sendMessage({ t: 'tabterm:count-terminal-tabs' }).then((reply: unknown) => {
    const tabCount = Number((reply as { count?: number } | undefined)?.count ?? 1);
    document.body.replaceChildren(
      buildReset({
        sessions,
        tabCount,
        onCancel: () => window.close(),
        onConfirm: (restartDaemon) => {
          client?.send({ t: 'reset-everything', restartDaemon });
        },
      }),
    );
  });
}

/**
 * Which sessions asked for their tab to flash when a command finishes.
 *
 * Held in memory as well as in storage, so the menu can be built and measured without waiting
 * on a read. Refreshed whenever it changes.
 */
let flashing = new Set<string>();

function refreshFlashing(): void {
  void flashingSessions().then((set) => (flashing = set));
}

/**
 * Two alternating icons, painted over whatever the tab would otherwise show.
 *
 * It used to alternate `done` and `idle`, on the reasoning that the flash should be made of
 * icons the product already draws rather than a third thing nobody has seen. Both of those sit
 * on the same dark grey, one with a grey bar and one with a blue caret, so across a strip of
 * twenty tabs the flash was invisible: which was the entire report.
 *
 * A tick on green alternating with a tick on amber. The shape stays put so it reads as one tab
 * asking for something, and only the ground changes.
 */
const tabFlasher = new TabFlasher(
  (on) => {
    applyFavicon(drawFavicon(on ? 'attention' : 'attention-alt', animPhase));
  },
  () => {
    // Back to whatever the panes actually say, which is what the icon meant before the flash.
    setFavicon(paneStatus.effective());
  },
);

/**
 * Remove the lone `%` zsh sometimes leaves above the first prompt.
 *
 * It is zsh's partial-line marker: output that did not end in a newline gets an inverse `%` so
 * the prompt starts on a clean line. It is correct and it is noise, and on the start screen,
 * where the terminal is a two-line strip, it takes half of what you can see.
 *
 * Removed by asking the shell to redraw rather than by editing the buffer, so the screen stays
 * something the shell produced. Only when it is the only thing above the prompt, and only while
 * the start screen is up: over real output that marker is telling you something true.
 */
function tidyPartialLine(paneId: string): void {
  const pane = panesHost?.get(paneId);
  if (!pane || launcher?.dismissed !== false) return;
  const buffer = pane.controller.term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length && lines.length < 3; y++) {
    const text = (buffer.getLine(y)?.translateToString(true) ?? '').trim();
    if (text !== '') lines.push(text);
  }
  if (lines.length !== 2 || lines[0] !== '%') return;
  // Ctrl+L: the shell's own clear-and-redraw, which is what puts the prompt back cleanly.
  client?.write(pane.streamId, new TextEncoder().encode(String.fromCharCode(12)));
}

/**
 * Every decision about the icon, most recent last.
 *
 * The icon is the one part of this product that is read from another tab, and until this existed
 * the only account of why it showed what it showed was the pixels. A report of one stuck on the
 * wrong state had nothing behind it to look at.
 */
const faviconLog: {
  at: number;
  asked: FaviconState;
  drew: FaviconState | 'nothing';
  why: string;
}[] = [];

function recordFavicon(asked: FaviconState, drew: FaviconState | 'nothing', why: string): void {
  faviconLog.push({ at: Date.now(), asked, drew, why });
  if (faviconLog.length > 200) faviconLog.shift();
}

function setFavicon(state: FaviconState): void {
  // A flash is a deliberate override and outranks the ordinary icon until it is noticed.
  if (tabFlasher.flashing) {
    /**
     * The state is still remembered, even though nothing is drawn.
     *
     * Dropping it as well as the drawing left the page believing the icon said whatever it said
     * before the flash began, and the repaint a tab does when it is hidden then drew that. The
     * flash restores from the machine when it ends, so the only thing this needs to keep right
     * is what the page thinks is on the tab.
     */
    faviconState = state;
    recordFavicon(state, 'nothing', 'flashing');
    return;
  }
  faviconState = state;
  clearInterval(animTimer);
  animTimer = undefined;
  // In the lowest memory mode a hidden tab stops redrawing its icon. Nothing is lost: the
  // favicon is brought up to date the moment the tab is looked at again.
  if (!memorySettings.faviconWhileHidden && document.visibilityState === 'hidden') {
    recordFavicon(state, 'nothing', 'hidden-and-saving-memory');
    return;
  }
  applyFavicon(drawFavicon(state, animPhase));
  recordFavicon(state, state, 'drawn');

  const visible = document.visibilityState === 'visible';
  /**
   * Animation only where it can happen.
   *
   * A hidden tab cannot drive its own: measured at **one frame per minute** from the second
   * minute onward, so a pulse there would be a still image that occasionally jumps. The pane
   * that needs a person gets a distinct static icon instead, and the thing that actually
   * reaches somebody who is looking elsewhere is the notification.
   * See docs/10-limitations.md tier 1.1.
   */
  if (!visible) return;
  if (state === 'running') {
    animTimer = window.setInterval(() => {
      animPhase++;
      applyFavicon(drawFavicon('running', animPhase));
    }, 200);
  } else if (needsAttention(state)) {
    animTimer = window.setInterval(() => {
      animPhase++;
      applyFavicon(drawFavicon(state, animPhase));
    }, 220);
  }
}

/**
 * What a tab shows when its session is gone.
 *
 * Chrome offers no way to remove one entry from its recently-closed stack, so restoring the URL
 * of an expired session is normal rather than exceptional. It has to be a useful screen, and
 * nothing on it ever runs by itself. See docs/04-session-lifecycle.md §8.
 */
/**
 * Confirm text that came from a webpage before it reaches the shell.
 *
 * The whole point of the overlay is that the user reads the exact string. It is rendered with
 * textContent into a `pre`, never as markup, and the accept path sends it **without a trailing
 * newline**, so it lands at the prompt and waits. See docs/05-security.md §4.
 */
function showStaged(text: string, source: string): void {
  const panel = document.getElementById('staged') as HTMLElement;
  (document.getElementById('staged-text') as HTMLElement).textContent = text;
  (document.getElementById('staged-source') as HTMLElement).textContent = `From ${source}`;
  panel.hidden = false;

  const dismiss = () => {
    panel.hidden = true;
    // Take the parameters out of the URL, so a reload or a Chrome restore does not re-ask
    // about something the user already answered.
    const url = new URL(location.href);
    url.searchParams.delete('staged');
    url.searchParams.delete('stagedFrom');
    history.replaceState(null, '', url.toString());
    if (splitView?.focused) panesHost?.focus(splitView.focused);
  };

  (document.getElementById('staged-accept') as HTMLElement).onclick = () => {
    // No newline. This is the difference between staging and running.
    sendToFocusedPane(text);
    dismiss();
  };
  (document.getElementById('staged-cancel') as HTMLElement).onclick = dismiss;
}

/**
 * Offer to open a server the terminal just noticed.
 *
 * An offer rather than an action: opening a tab because a process bound a port would be a
 * browser doing something nobody asked for. It fades out on its own, because a dev server
 * restart should not leave a queue of notices behind.
 */
function showServerOffer(port: number): void {
  const bar = document.getElementById('server-offer') as HTMLElement;
  const open = document.getElementById('server-open') as HTMLButtonElement;
  (document.getElementById('server-text') as HTMLElement).textContent =
    `Listening on port ${String(port)}`;
  open.textContent = `Open localhost:${String(port)}`;
  open.onclick = () => {
    void chrome.runtime.sendMessage({ t: 'tabterm:open-local', port });
    bar.hidden = true;
  };
  (document.getElementById('server-dismiss') as HTMLElement).onclick = () => {
    bar.hidden = true;
  };
  bar.hidden = false;
  clearTimeout(serverOfferTimer);
  serverOfferTimer = setTimeout(() => {
    bar.hidden = true;
  }, 20_000);
}
let serverOfferTimer: ReturnType<typeof setTimeout> | undefined;

function showRecovery(reason: string): void {
  recoveryEl.hidden = false;
  root.style.display = 'none';
  (document.getElementById('recovery-reason') as HTMLElement).textContent = reason;
  // Ask what we can remember about it, so the offer can be specific.
  if (workspaceId) client?.send({ t: 'recall-workspace', workspaceId });
  client?.send({ t: 'list-resumable', limit: 8 });
}

function renderRecoveryActions(recall: {
  found: boolean;
  cwd?: string;
  lastCommand?: string;
  lastSeenAt?: number;
  lastScreen?: readonly string[];
}): void {
  const detail = document.getElementById('recovery-detail') as HTMLElement;
  const actions = document.getElementById('recovery-actions') as HTMLElement;
  detail.replaceChildren();
  actions.replaceChildren();

  if (recall.found && recall.cwd) {
    const rows: [string, string][] = [['Last directory', recall.cwd]];
    if (recall.lastCommand) rows.push(['Last command', recall.lastCommand]);
    if (recall.lastSeenAt) rows.push(['Ended', relativeTime(recall.lastSeenAt)]);
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'recovery-row';
      const k = document.createElement('span');
      k.className = 'recovery-key';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'recovery-value';
      v.textContent = value;
      row.append(k, v);
      detail.append(row);
    }

    /**
     * What was on the screen when it ended.
     *
     * The processes are gone and cannot come back, but the output is still here, so the tab can
     * show what happened rather than only where it happened. Without this the history is
     * written, bounded, pruned and never seen by anybody.
     */
    if (recall.lastScreen && recall.lastScreen.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'recovery-key';
      heading.textContent = 'Last output';
      detail.append(heading);

      const screen = document.createElement('div');
      screen.className = 'session-screen recovery-screen';
      for (const line of recall.lastScreen) {
        const lineEl = document.createElement('div');
        lineEl.className = 'session-line';
        lineEl.textContent = line === '' ? '\u00a0' : line;
        screen.append(lineEl);
      }
      detail.append(screen);
    }
  }

  const button = (label: string, onClick: () => void, primary = false) => {
    const b = document.createElement('button');
    // `is-selected` already means 'the one Return will run' everywhere else on the page.
    b.className = primary ? 'launcher-chip is-selected' : 'launcher-chip';
    b.textContent = label;
    b.addEventListener('click', onClick);
    actions.append(b);
    /**
     * The first offer takes focus, so Return is enough.
     *
     * Chrome cannot be asked to forget one entry in its recently-closed stack, so landing here
     * from Command+Shift+T is ordinary. Arriving at a page whose only way forward is finding a
     * button with the mouse makes the restore feel like a dead end, when what somebody wanted
     * was a shell in that folder.
     *
     * Focused, not run. Nothing on this page starts by itself, which is the rule in
     * docs/04-session-lifecycle.md and the reason the page can be trusted at all: a restored tab
     * that spawned a shell on its own would mean Chrome reopening ten tabs spawns ten shells.
     */
    if (primary) b.focus();
  };

  if (recall.found && recall.cwd) {
    const cwd = recall.cwd;
    button('Start a shell here again', () => startFresh(cwd), true);

    // If an agent was working here, picking that conversation back up is usually what someone
    // wants after an expiry. Offered, never done automatically.
    const resumable = resumableSessions.find((r) => r.cwd === cwd);
    if (resumable) {
      button(`Resume the agent session here`, () => {
        recoveryEl.hidden = true;
        root.style.display = '';
        /**
         * Measured, like every other way of starting something.
         *
         * This was the one place that sent a hardcoded eighty by twenty-four, so resuming a
         * conversation from the recovery page started the agent at eighty columns and moved it
         * to the real width a moment later. An agent redraws itself completely on a resize, so
         * that is the whole conversation reflowed twice before it is even readable.
         */
        client?.send({
          t: 'resume-agent',
          sessionId: resumable.sessionId,
          cwd,
          ...(panesHost?.fit(splitView?.focused ?? '') ?? attachSize()),
        });
      });
    }
  }
  button('Start a shell in home', () => startFresh(undefined), !(recall.found && recall.cwd));
  button('Close tab', () => window.close());
}

/** What the daemon last reported as resumable, so the recovery page can offer it too. */
let resumableSessions: readonly ResumableAgentSession[] = [];

/** A new session, never an automatic one. The user asked for this by clicking. */
function startFresh(cwd: string | undefined): void {
  workspaceId = '';
  const url = new URL(location.href);
  url.searchParams.delete('workspace');
  history.replaceState(null, '', url.toString());
  recoveryEl.hidden = true;
  root.style.display = '';
  client?.send({ t: 'create-session', ...attachSize(), ...(cwd ? { cwd } : {}) });
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isCwdIndependent(candidate: string): boolean {
  return candidate.startsWith('/') || candidate.startsWith('~');
}
function cacheKey(candidate: string, cwd = currentCwd): string {
  return isCwdIndependent(candidate) ? candidate : `${cwd}\u0000${candidate}`;
}
function lookupPath(candidate: string): ResolvedPath | undefined {
  return pathCache.get(cacheKey(candidate));
}

// ---------------------------------------------------------------------------
// Modifier tracking
// ---------------------------------------------------------------------------

/**
 * The chooser drawn over a pane that has nothing in it.
 *
 * Only for a workspace with more than one pane. A single pane already has the start screen over
 * it, and two panels saying the same thing would be worse than one.
 */
const paneChoosers = new Map<string, PaneChooser>();

function syncPaneChoosers(): void {
  const paneIds = layout ? collectPanes(layout) : [];
  for (const [paneId, chooser] of paneChoosers) {
    if (!paneIds.includes(paneId)) {
      chooser.dismiss();
      paneChoosers.delete(paneId);
      continue;
    }
    /**
     * And one whose pane has since printed something goes too.
     *
     * The offer is for a pane with nothing in it. A pane opened to run something has nothing in
     * it for the moment it takes the program to start, so the offer was drawn and then stayed
     * over a running agent, asking whether to open a folder there. The question is decided by
     * what is on the pane, so it is asked again whenever that changes rather than only once.
     */
    const pane = panesHost?.get(paneId);
    if (pane && linesWithContent(pane.controller.term) > 1) {
      chooser.dismiss();
      paneChoosers.delete(paneId);
    }
  }
  if (paneIds.length < 2) return;

  for (const paneId of paneIds) {
    if (paneChoosers.has(paneId)) continue;
    const pane = panesHost?.get(paneId);
    if (!pane) continue;
    /**
     * Only a pane with nothing in it.
     *
     * Every pane in a multi-pane tab used to get one, so a session merged into a pane arrived
     * with a chooser drawn over its output, offering to replace what had just been put there.
     * A fresh shell has printed a prompt and nothing else; anything more means the pane is in
     * use and has no business being covered.
     */
    if (linesWithContent(pane.controller.term) > 1) continue;
    paneChoosers.set(
      paneId,
      new PaneChooser({
        container: pane.element,
        paneId,
        home: launcherHome,
        liveSessions: () => liveElsewhere,
        // The pane under this overlay keeps its own menu. See `PaneChooserOptions`.
        onContextMenu: (id, x, y) => panesHost?.get(id)?.controller.openMenuAt(x, y),
        onDismiss: (id) => panesHost?.focus(id),
        onChooseDir: (id, path) => {
          const target = panesHost?.get(id);
          if (!target) return;
          splitView?.focus(id);
          client?.write(target.streamId, new TextEncoder().encode(`cd ${quotePath(path)}\r`));
          paneChoosers.get(id)?.dismiss();
        },
        onListFolder: (path) => {
          // The same completion the start screen browses with: a trailing slash asks for what
          // is inside a directory rather than for a suggestion.
          completingPane = paneId;
          client?.send({ t: 'complete-path', partial: path });
        },
        onTakeSession: (id, session) => {
          if (!workspaceId) return;
          // Moving it, not copying it: a session lives in exactly one workspace, so the tab it
          // came from is asked to close rather than left showing a workspace with nothing in it.
          takingOverFrom.add(session.workspaceId);
          client?.send({
            t: 'merge-into',
            workspaceId,
            targetPaneId: id,
            sessionId: session.sessionId,
            // Into this pane, not beside it. Only a pane nobody has typed into offers this, so
            // the shell being replaced has done nothing, and splitting it left that empty shell
            // sitting next to the session that was asked for.
            direction: 'horizontal',
            replace: true,
          });
          paneChoosers.get(id)?.dismiss();
        },
        onRefreshSessions: () => {
          // Both lists: what may be moved comes from the daemon's mergeable answer, and what it
          // looks like comes from the live one. A chooser opened before either has arrived would
          // otherwise offer nothing at all.
          client?.send({ t: 'list-live-sessions' });
          if (workspaceId) client?.send({ t: 'list-mergeable', workspaceId });
        },
      }),
    );
  }
}

/** How much a pane has printed, which is how an empty one is told from one in use. */
/**
 * Has anything happened in this tab yet?
 *
 * True for a tab that is still showing its start screen with a shell nobody has typed into:
 * one pane, one line on it, which is the prompt. That is the tab that should be taken over or
 * closed rather than left beside whatever was just opened.
 *
 * Deliberately conservative. Anything it cannot be sure about counts as used, because closing a
 * tab somebody was working in is far worse than leaving an empty one.
 */
/**
 * Draw the start screen, **and give it the room it needs**.
 *
 * There were two places that put the start screen up and only one of them told the terminal to
 * make way. The other, the deferred decision a reattaching tab makes once its snapshot has
 * arrived, called `launcher.show()` on its own: the panel appeared over a terminal still using
 * the whole window, so the prompt was drawn at the top of the window, behind the opaque panel,
 * and the strip at the bottom showed row 24 of a screen whose only line was row 1.
 *
 * That is the empty box reported three times as "the prompt is gone". It was on screen the whole
 * time, under something. Both attempts to fix it looked at the buffer, which was right, and at
 * scrolling, which could not help: a terminal filling the window has nothing to scroll.
 */
/**
 * Show whichever of the two this tab turned out to be, once and only once.
 *
 * Called when the snapshot has been applied, and by a timer as a ceiling. Everything before this
 * point is the tab deciding what it is, and during that time it shows neither.
 */
/** What the last decision was made on, so a wrong one can be read rather than guessed at. */
let startScreenReason: Record<string, unknown> = {};

function decideStartScreen(): void {
  if (startScreenDecided) return;
  startScreenDecided = true;
  root.classList.remove('deciding');
  {
    const only = (panesHost?.all ?? [])[0];
    startScreenReason = {
      launched: hasLaunched(),
      panes: panesHost?.all.length ?? 0,
      lines: only ? linesWithContent(only.controller.term) : -1,
      withCommand: only ? panesWithCommand.has(only.paneId) : false,
      unused: thisTabIsUnused(),
    };
  }
  // Empty after the snapshot means the tab really has nothing in it, and the start screen is
  // what belongs there. Anything else keeps its terminal.
  if (thisTabIsUnused()) {
    openStartScreen();
    return;
  }
  launcher?.dismiss();
  /**
   * And the terminal takes the keyboard, so it looks like the thing that has it.
   *
   * Typing already reached the shell without this, because a keystroke with nowhere better to go
   * is handed to the focused pane. What was missing is the cursor: a terminal nothing has focused
   * draws a hollow one, so after every refresh the screen said the keyboard was somewhere else
   * while it was in fact right here. Being able to type into something that does not look like it
   * is taking typing is its own kind of broken.
   */
  const focused = splitView?.focused;
  if (focused) panesHost?.focus(focused);
}

function openStartScreen(): void {
  if (!launcher || launcher.dismissed || hasLaunched()) return;
  launcher.show();
  root.classList.add('panel-open');
  refitAllPanes();
}

/**
 * Ways back from closing a pane and from moving one to its own tab.
 *
 * The daemon holds a closed pane's terminal for five minutes rather than ending it, and a
 * detached one is alive in the tab it moved to, so both are genuinely recoverable for a while.
 * This is the offer, and Command+Z is the same offer reached the way undo is reached everywhere.
 */
const undoStack = new UndoStack();
let undoOfferHidden = false;
let undoOfferTimer: number | undefined;

function offerUndo(offer: UndoOffer): void {
  undoStack.setDepth(Math.max(1, layout ? collectPanes(layout).length + 1 : 1));
  undoStack.push(offer);
  undoOfferHidden = false;
  drawUndoOffer();
}

/**
 * Draw the topmost offer, or nothing.
 *
 * Redrawn on a timer as well as on every change, because an offer expires by the clock and a
 * button that has quietly stopped working is worse than no button.
 */
function drawUndoOffer(): void {
  const wrap = document.getElementById('undo-offer');
  const act = document.getElementById('undo-offer-do');
  const hide = document.getElementById('undo-offer-hide');
  if (!(wrap instanceof HTMLElement) || !(act instanceof HTMLButtonElement)) return;
  if (hide instanceof HTMLButtonElement) {
    hide.onclick = () => {
      // Hidden, not given up. The key keeps working for the rest of the window.
      undoOfferHidden = true;
      drawUndoOffer();
    };
  }

  const offer = undoStack.next();
  clearTimeout(undoOfferTimer);
  if (!offer) {
    wrap.hidden = true;
    return;
  }
  // Checked again when it should have expired, so the button goes on its own.
  undoOfferTimer = window.setTimeout(drawUndoOffer, Math.max(1000, UNDO_WINDOW_MS / 30));
  if (undoOfferHidden) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  act.textContent = offerLabel(offer, launcherHome);
  act.title =
    offer.kind === 'closed'
      ? 'Bring this terminal back into this tab. Command+Z'
      : 'Bring this terminal back from the tab it moved to. Command+Z';
  act.onclick = () => takeUndoOffer();
}

/**
 * Take the most recent offer, which is what both the button and Command+Z do.
 *
 * Returns whether anything was taken, so the key can fall through to the shell when there was
 * nothing on offer.
 */
function takeUndoOffer(): boolean {
  const offer = undoStack.next();
  if (!offer || !workspaceId) return false;
  undoStack.remove(offer.sessionId);
  // The focused pane, or any pane: this tab has at least one, and an empty id would be refused.
  const targetPaneId = splitView?.focused ?? (layout ? collectPanes(layout)[0] : undefined);
  if (offer.kind === 'closed') {
    client?.send({
      t: 'reopen-pane',
      workspaceId,
      sessionId: offer.sessionId,
      ...(targetPaneId ? { targetPaneId } : {}),
    });
  } else {
    /**
     * A detached pane comes back the way any session is brought in, which also closes the tab
     * it went to.
     *
     * The daemon refuses if it has since been taken somewhere else, and the tab that holds it
     * is told it has been taken over rather than that it expired.
     */
    if (offer.workspaceId) takingOverFrom.add(offer.workspaceId);
    client?.send({
      t: 'merge-into',
      workspaceId,
      targetPaneId: targetPaneId ?? '',
      sessionId: offer.sessionId,
      direction: 'horizontal',
    });
  }
  drawUndoOffer();
  return true;
}

function thisTabIsUnused(): boolean {
  /**
   * A tab that has already started something never goes back to the start screen.
   *
   * The screen was the only evidence, which is a guess and gets it wrong in a case that is not
   * rare at all: a template opened in the home directory, with panes that have printed only a
   * prompt, looks exactly like a tab that has never begun. Refreshing it flashed the start
   * screen over work that was already there, and closing panes back down to one made it worse
   * rather than better.
   *
   * `sessionStorage` is the right place for the answer. It belongs to this tab and to no other,
   * it survives a reload, which is the whole point, and it is gone when the tab is, which is
   * also right: a new tab has not started anything.
   */
  if (hasLaunched()) return false;

  const panes = panesHost?.all ?? [];
  /**
   * No panes at all is nothing here, **unless this tab is attaching to a workspace**.
   *
   * Zero panes used to fall through the same door as two and answer "in use", so a tab whose
   * ceiling fired before any pane existed dismissed the start screen and gave the whole page to
   * an empty terminal. Two panes really is work. Zero usually is not.
   *
   * Usually. A tab opened on a workspace has work by definition: the panes are on their way and
   * the only reason there are none yet is that the daemon has not answered. Reading that as an
   * empty tab put the start screen over a session somebody was coming back to, which is the one
   * thing a reattaching tab must never do.
   */
  if (panes.length === 0) {
    return new URL(location.href).searchParams.get('workspace') === null;
  }
  if (panes.length !== 1) return false;
  const only = panes[0];
  if (!only) return false;

  /**
   * And a pane that something was launched into is never a start screen, whatever is on it.
   *
   * `sessionStorage` is the usual answer and it survives a reload, but it does not survive the
   * tab being recreated, which is what an extension reload does to every tab. After one of
   * those, the only evidence left was the screen, and the screen is a guess that is wrong in
   * exactly the case that hurts most: an agent that has printed nothing yet, or one showing a
   * compact prompt, has as few lines on it as a shell nobody has used. Drawing the start screen
   * over it squeezes the terminal into a three row strip, and a full-screen program redraws
   * itself into three rows.
   *
   * The daemon knows, because it started the process, and now says so with the pane.
   */
  if (panesWithCommand.has(only.paneId)) return false;

  return linesWithContent(only.controller.term) <= 1;
}

/**
 * Panes whose session was started with a command rather than as a bare shell.
 *
 * Reported by the daemon on attach, which is the only place the fact is known before output
 * arrives. Not cleared when a pane closes: the set is small, bounded by the panes a tab has ever
 * held, and a stale entry could only ever make this more conservative.
 */
const panesWithCommand = new Set<string>();

const LAUNCHED = 'tabterm.launched';

/** Has this tab ever left the start screen? */
function hasLaunched(): boolean {
  try {
    return sessionStorage.getItem(LAUNCHED) === '1';
  } catch {
    // Storage a browser refuses is no memory, and no memory is the old behaviour rather than a
    // failure: the screen is guessed from the panes, which is right more often than not.
    return false;
  }
}

function rememberLaunched(): void {
  try {
    sessionStorage.setItem(LAUNCHED, '1');
  } catch {
    /* See above. */
  }
}

/**
 * Where a command was run, if its line is still in the buffer.
 *
 * Matched on the text of the command, searching from the end, because the row a person means by
 * "this one" is the most recent time they ran it. Null when the output has scrolled off, which
 * is what keeps the offer honest.
 */
function findCommandRow(command: string): number | null {
  const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
  if (!pane) return null;
  const wanted = command.trim();
  if (wanted === '') return null;
  const buffer = pane.controller.term.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row--) {
    const text = buffer.getLine(row)?.translateToString(true) ?? '';
    if (text.includes(wanted)) return row;
  }
  return null;
}

/** Workspaces this tab has just taken a session from, so their tabs know to close. */
const takingOverFrom = new Set<string>();
/** Which pane asked for a completion, since the answer comes back on one channel. */
let completingPane: string | null = null;
/** Home, as the daemon reports it, for shortening paths in a pane chooser. */
let launcherHome = '';

function setCmdHeld(held: boolean): void {
  if (held === cmdHeld) return;
  cmdHeld = held;
  document.body.classList.toggle('cmd-held', held);
  panesHost?.refreshLinks();
}

/**
 * Keep the terminal ready to type into, always.
 *
 * A terminal has no other controls, so nobody expects to have to click into one before typing.
 * This page does have other controls -- the launcher, its buttons, the palette -- and clicking
 * any of them takes DOM focus away, after which keystrokes went nowhere. That is not a terminal.
 *
 * The rule: **if you are not deliberately typing into a text field, you are typing into the
 * terminal.** Focus is moved on the way in, during the capture phase, so the keystroke that
 * triggered it lands in the terminal rather than being swallowed as the price of getting there.
 *
 * A real text field keeps its keys: the palette's search box, the launcher's path box, and the
 * placeholder inputs are all places where typing means something else, and each one is where
 * the user deliberately put the cursor.
 */
/**
 * A right click anywhere in TabTerm opens a TabTerm menu.
 *
 * Asked for directly: "i want right click anywhere in tabterm to just be tabterm related stuff,
 * not the chrome right click". Chrome's menu knows nothing about any of this. On a page whose
 * content is drawn on a canvas it offers Reload and Save As, neither of which means anything
 * here, and on the start screen it offers to translate the page.
 *
 * What it offers depends on where the click landed, because a menu that offers the same six
 * things everywhere is a list to read past rather than a set of things to do:
 *
 * - **A terminal** keeps its own menu, which is much richer: selection, highlights, markers, the
 *   pane's own actions. Nothing here touches it.
 * - **A text box** gets the three clipboard entries a text box should have, acting on that box.
 * - **The start screen** gets paste and the ways out: a new tab, the menu, settings.
 * - **The command menu** gets settings and a way to put it away.
 * - **Anywhere else** gets the same small set, minus paste, which would have nowhere to go.
 *
 * Markers and highlights are deliberately absent outside a terminal. They act on a place in a
 * screen of output, and there is no such place on the start screen.
 */
function installPageMenu(): void {
  document.addEventListener('contextmenu', (e) => {
    /**
     * Anything that has already answered keeps its answer.
     *
     * The terminal and the pane chooser handle this themselves and call `preventDefault`. This
     * runs in the bubble phase and after them, so a handled click arrives here already spoken
     * for, and a second menu over the first would be worse than Chrome's.
     */
    if (e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // Inside a menu that is already open, a right click is how it is dismissed.
    if (target.closest('.term-menu')) return;

    const items = pageMenuItems(target);
    if (items.length === 0) return;
    e.preventDefault();
    const menu = menuShell();
    fillMenu(menu, items);
    placeAndArm(menu, e.clientX, e.clientY);
  });
}

/** The clipboard entries a text box should have, acting on the box that was clicked. */
function textBoxItems(clicked: HTMLInputElement | HTMLTextAreaElement): ShellItem[] {
  /**
   * The box as it is when the entry runs, not as it was when the menu was built.
   *
   * A menu stays open while the page carries on, and the start screen redraws whenever anything
   * changes: a session starting, a folder being recorded. The redraw replaces its inputs, so the
   * element captured at right-click time is detached by the time an entry runs, and `focus` and
   * `select` on a detached element do nothing at all and report nothing. The same trap as setting
   * `scrollTop` on one, and just as quiet.
   */
  const live = (): HTMLInputElement | HTMLTextAreaElement => {
    if (clicked.isConnected) return clicked;
    const byId = clicked.id === '' ? null : document.getElementById(clicked.id);
    if (byId instanceof HTMLInputElement || byId instanceof HTMLTextAreaElement) return byId;
    const byClass =
      clicked.className === ''
        ? null
        : document.querySelector(`.${clicked.className.trim().split(/\s+/).join('.')}`);
    if (byClass instanceof HTMLInputElement || byClass instanceof HTMLTextAreaElement) {
      return byClass;
    }
    return clicked;
  };
  const box = clicked;
  const selected = box.selectionStart !== box.selectionEnd;
  const replaceSelection = (text: string): void => {
    const target = live();
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.value = target.value.slice(0, start) + text + target.value.slice(end);
    const at = start + text.length;
    target.setSelectionRange(at, at);
    // Dispatched, because everything that watches this box watches for input rather than polling.
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
  };
  return [
    {
      label: 'Cut',
      enabled: selected,
      run: () => {
        const target = live();
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? 0;
        void navigator.clipboard.writeText(target.value.slice(start, end)).catch(() => {});
        replaceSelection('');
      },
    },
    {
      label: 'Copy',
      enabled: selected,
      run: () => {
        const target = live();
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? 0;
        void navigator.clipboard.writeText(target.value.slice(start, end)).catch(() => {});
      },
    },
    {
      label: 'Paste',
      run: () => {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) replaceSelection(text);
          })
          .catch(() => {
            /* denied or empty */
          });
      },
    },
    {
      label: 'Select all',
      separated: true,
      enabled: box.value !== '',
      run: () => {
        const target = live();
        target.focus();
        target.select();
      },
    },
  ];
}

/** The ways out of wherever you are, which every one of these menus ends with. */
function wayOutItems(separated: boolean): ShellItem[] {
  return [
    {
      label: 'New terminal tab',
      separated,
      run: () => {
        void chrome.tabs.create({ url: chrome.runtime.getURL('terminal.html'), active: true });
      },
    },
    menuToggleItem(),
    { label: 'Settings', run: () => commandPanel?.openSettings() },
  ];
}

/**
 * One entry, saying what it will do rather than what it is called.
 *
 * "Open menu" while the menu is open is an entry that either does nothing or reads as a bug. The
 * menu is one thing with two states, so the row follows the state it is in. Right-clicking inside
 * the panel already said "Close menu"; everywhere else went on offering to open what was open.
 */
function menuToggleItem(): ShellItem {
  return commandPanel?.isOpen === true
    ? { label: 'Close menu', run: () => commandPanel?.close() }
    : { label: 'Open menu', run: () => commandPanel?.open() };
}

function pageMenuItems(target: Element): ShellItem[] {
  const box = target.closest('input, textarea');
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    // A box for typing into is a box for typing into, wherever it happens to be.
    return [...textBoxItems(box), ...wayOutItems(true)];
  }

  if (target.closest('.cmd-panel')) {
    /**
     * The command menu, which is already the place most of these lead to.
     *
     * Offering "Open menu" from inside the open menu would be a joke, so this is the one place
     * that gets a way to put it away instead.
     */
    return [
      { label: 'Settings', run: () => commandPanel?.openSettings() },
      { label: 'Close menu', separated: true, run: () => commandPanel?.close() },
    ];
  }

  const onStartScreen = target.closest('.launcher') !== null;
  return [
    /**
     * Paste, which on the start screen means into whichever box is taking typing.
     *
     * One of the two is always focused, by design, so this has somewhere to go. Off the start
     * screen there is no box and no terminal under the pointer, so it is left out rather than
     * offered and doing nothing.
     */
    ...(onStartScreen
      ? [
          {
            label: 'Paste',
            run: () => {
              void navigator.clipboard
                .readText()
                .then((text) => {
                  if (!text) return;
                  const focused = document.activeElement;
                  if (
                    focused instanceof HTMLInputElement ||
                    focused instanceof HTMLTextAreaElement
                  ) {
                    const at = focused.selectionStart ?? focused.value.length;
                    focused.value = focused.value.slice(0, at) + text + focused.value.slice(at);
                    focused.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                  }
                  const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
                  pane?.controller.term.paste(text);
                })
                .catch(() => {
                  /* denied or empty */
                });
            },
          } satisfies ShellItem,
        ]
      : []),
    ...wayOutItems(onStartScreen),
    {
      // "Session", not "tab": what closing it gets rid of is the terminal in it. The same
      // wording the pane's own menu uses, for the same reason.
      label: 'Close tab',
      separated: true,
      run: () => window.close(),
    },
  ];
}

/**
 * Whatever will receive the next keystroke shows a cursor, at all times.
 *
 * Stated as an invariant rather than fixed where it was found, because it has now been reported
 * three times about three different moments: after a refresh, after placing a marker, and after
 * undoing a closed pane. Each time typing worked and the screen said it would not. "i need it to
 * be consistently present whenever typing is an option somewhere."
 *
 * Two halves, and the second is the one that kept being missed. Routing a keystroke to the
 * terminal when it arrives is not enough: by then the person has already typed into something
 * that looked dead. The terminal has to hold the keyboard **before** anything is typed.
 *
 * What owns the keyboard, in order:
 *
 * 1. A real text field somebody put the cursor in. It draws its own caret and nothing takes it
 * 2. The command menu or the palette while either is open. Both manage their own focus, and two
 *    surfaces cannot both be active
 * 3. Otherwise the focused pane's terminal, which is where typing goes anyway
 */
function keepCursorSomewhere(): void {
  if (palette?.isOpen === true || commandPanel?.isOpen === true) return;
  const active = document.activeElement;
  if (isTypingField(active)) return;
  /**
   * Only when nothing holds it.
   *
   * A button somebody just pressed keeps focus until they move on, and taking it away mid-press
   * would break every keyboard route through the interface.
   */
  if (active !== null && active !== document.body && active !== document.documentElement) return;
  const paneId = splitView?.focused ?? panesHost?.all[0]?.paneId;
  if (paneId) panesHost?.focus(paneId);
}

/** A place typing means something other than terminal input. xterm's own textarea is not one. */
function isTypingField(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node.classList.contains('xterm-helper-textarea')) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function installAmbientFocus(): void {
  const isTextField = (node: EventTarget | null): boolean => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    // xterm's own hidden textarea is the terminal, not a competing field.
    if (node.classList.contains('xterm-helper-textarea')) return false;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  // Escape closes the panel wherever focus happens to be. Clicking into the terminal while it
  // is open is a reasonable thing to do, and it should not leave the panel with no way out
  // except reaching for the mouse.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && commandPanel?.isOpen) {
        e.preventDefault();
        /**
         * A question takes Escape before the panel does.
         *
         * This runs in the capture phase, so it answered Escape before the panel's own handler
         * ever saw it, and declining to delete a favorite threw away the list being read as
         * well. Escape closes one thing: whichever is on top.
         */
        /**
         * And it stops here, because this handler has decided what Escape meant.
         *
         * It runs in the capture phase, so without this the event went on to the panel's own
         * handler, which found no question left to dismiss and closed the panel: the question
         * was taken away and the list with it, which is the whole of what this was meant to stop.
         */
        e.stopPropagation();
        if (commandPanel.hasQuestion) commandPanel.dismissQuestion();
        else commandPanel.close();
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      // The command panel takes the keyboard while it is open. Two surfaces cannot both be
      // active, and a terminal that keeps accepting keystrokes behind an open list is the
      // clearest way to type into the wrong one.
      if (commandPanel?.isOpen) return;
      if (isTextField(document.activeElement)) return;
      // Browser and system shortcuts are not typing, and stealing focus for them would move the
      // cursor for something that never reaches the page anyway.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const paneId = splitView?.focused ?? panesHost?.all[0]?.paneId;
      if (paneId) panesHost?.focus(paneId);
    },
    true,
  );

  /**
   * And the keyboard is never left lying on the floor.
   *
   * An element that had focus and is then removed from the document takes the focus with it:
   * `activeElement` becomes the body, no `blur` is reliably delivered, and the page is left in a
   * state where typing works and nothing on screen says so. That is exactly what a redraw of the
   * start screen does, and what putting a pane back does, and it is why this kept being reported
   * about a different moment each time.
   *
   * Two ways of noticing, because neither is enough alone. `focusout` with nothing gaining focus
   * covers what the browser tells us about; the timer covers what it does not, and costs one
   * property read twice a second.
   */
  document.addEventListener('focusout', (e) => {
    if (e.relatedTarget !== null) return;
    setTimeout(keepCursorSomewhere, 0);
  });
  window.setInterval(keepCursorSomewhere, 500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepCursorSomewhere();
  });

  // Clicking a button does its job and hands the keyboard straight back, so the next thing you
  // type goes where it would have gone if you had never touched the mouse.
  document.addEventListener('click', (e) => {
    if (isTextField(e.target)) return;
    if (palette?.isOpen || commandPanel?.isOpen) return;
    // A click inside the panel belongs to the panel.
    if (e.target instanceof HTMLElement && e.target.closest('.cmd-panel, .cmd-puck')) return;
    // A click inside a pane is already handled by the pane itself, which focuses the right one.
    if (e.target instanceof HTMLElement && e.target.closest('.pane')) return;
    const paneId = splitView?.focused ?? panesHost?.all[0]?.paneId;
    if (!paneId) return;
    setTimeout(() => {
      // Unless the click opened something that wants the keyboard. A menu entry is not a text
      // field, so this fired for every one of them and took focus back from the form the entry
      // had just opened, which is why naming anything meant clicking into the box first.
      if (isTextField(document.activeElement)) return;
      panesHost?.focus(paneId);
    }, 0);
  });
}

function installModifierTracking(): void {
  window.addEventListener('keydown', (e) => setCmdHeld(e.metaKey), { capture: true });
  window.addEventListener('keyup', (e) => setCmdHeld(e.metaKey), { capture: true });
  // Capture, so the modifier is known before xterm asks its link providers about the line
  // under the pointer. Bubbling ran after that question was already answered, and xterm caches
  // the answer per line, so moving along a path never asked again and the link stayed inert.
  window.addEventListener('mousemove', (e) => setCmdHeld(e.metaKey), { capture: true });
  window.addEventListener('blur', () => setCmdHeld(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') setCmdHeld(false);
  });
}

// ---------------------------------------------------------------------------
// Panes and layout
// ---------------------------------------------------------------------------

/** Counts bytes xterm has emitted, so a dead input path can be told apart from a dead renderer. */
let inputBytesSeen = 0;
/** Why the last edit was refused, so a test or a panel can report it. */
let lastSaveRejection = '';

/** What has been typed in each pane, for hotstring expansion. One per pane, never shared. */
const typedBuffers = new Map<string, TypedBuffer>();

/** Hotstrings come from the favorites the page already has. No separate message for them. */
function hotstrings(): { trigger: string; command: string }[] {
  return savedItems
    .filter((item) => item.hotstring)
    .map((item) => ({ trigger: item.hotstring as string, command: item.body }));
}
let lastStatus = 'unknown';

function buildHosts(): void {
  panesHost = new PaneHost({
    menuActions: (paneId) => paneMenuActions(paneId),
    highlightColor: () => recentColors.highlight[0] ?? DEFAULT_COLOR.highlight,
    highlightRecents: () => recentColors.highlight,
    onColorUsed: (color) => useColor('highlight', color),
    /**
     * Written down, because it is the difference between a pane that scrolls well and one that
     * does not, and it was invisible to everyone including the person feeling it.
     */
    /**
     * Not while the start screen is up.
     *
     * A tab showing its start screen still has a real terminal in it, a few rows tall below the
     * panel, and right-clicking that got the whole pane menu: split it, name it, mark a place in
     * it, kill it. None of that means anything in a tab where nothing has happened yet, and
     * splitting rearranged the layout under a panel that is not laid out for two panes, which is
     * what "split right and split down work from the homescreen and they make the view all
     * messed up" was.
     *
     * Declined rather than shortened, so the gesture travels on and the page answers it with the
     * start screen's own menu. `isShowing` rather than `dismissed`, because a start screen can be
     * drawn and not shown, and a menu decision has to follow what is on screen.
     */
    shouldOpenMenu: () => launcher?.isShowing !== true,
    onRendererLost: (paneId) => {
      client?.send({
        t: 'note',
        event: 'renderer-lost',
        detail: {
          paneId: paneId.slice(0, 8),
          panes: panesHost?.all.length ?? 0,
          visible: document.visibilityState === 'visible',
        },
      });
    },
    onData: (paneId, data) => {
      inputBytesSeen += data.length;
      const pane = panesHost?.get(paneId);
      if (!pane) return;
      // Counted before the shell sees it, because in a short terminal the shell does not put it
      // on the screen in any form this could count. See `input-line.ts`.
      inputLine.consume(data);
      growStripToFit();

      // Hotstrings act on the keystroke before it reaches the shell. Suspended while a
      // full-screen program owns the terminal, because the deletions this sends would be edits
      // there rather than corrections. See docs/14-command-menu.md §4.
      let typed = typedBuffers.get(paneId);
      if (!typed) {
        typed = new TypedBuffer();
        typedBuffers.set(paneId, typed);
      }
      typed.setSuspended(pane.controller.term.buffer.active.type === 'alternate');

      const expansion = typed.consume(data, hotstrings());
      if (expansion) {
        launcher?.dismiss();
        const rewritten = backspaces(expansion.deleteCount) + expansion.insert;
        client?.write(pane.streamId, new TextEncoder().encode(rewritten));
        return;
      }
      // The panel survives typing and goes when a command is actually sent. It is not a page
      // you leave to reach the terminal: the terminal is already underneath it, and what is
      // drawn on top is only there because there is no output yet. Dismissing on the first
      // keystroke made a half-typed command the moment everything disappeared, which is both
      // startling and useless, since that is exactly when you might still want the list.
      if (submitsCommand(data)) {
        launcher?.dismiss();
        paneChoosers.get(paneId)?.dismiss();
      }
      client?.write(pane.streamId, new TextEncoder().encode(data));
    },
    onResize: (paneId, cols, rows) => {
      // A size this pane was told to take is not a size it is asking for. See `session-size`.
      if (followingSize.has(paneId)) return;
      /**
       * Through the same door as every other request, so the record of what was asked stays true.
       *
       * This fires when the terminal itself changes size, including when it is changed to follow
       * a size the daemon reported. Sending straight to the daemon left the record saying one
       * thing and the daemon holding another, and the next report then looked like being
       * overruled, which is a resize, which fires this again.
       */
      askForSize(paneId, { cols, rows }, 'terminal-said-so');
    },
    onClear: (paneId) => {
      const pane = panesHost?.get(paneId);
      if (pane?.sessionId) client?.send({ t: 'clear-scrollback', sessionId: pane.sessionId });
      offerClearUndo(paneId);
    },
    resolvePaths: (paneId, candidates) => {
      const pane = panesHost?.get(paneId);
      if (!pane) return;
      const fresh = candidates.filter((x) => !pathsInFlight.has(cacheKey(x)));
      if (fresh.length === 0) return;
      for (const x of fresh) pathsInFlight.add(cacheKey(x));
      client?.send({ t: 'resolve-paths', sessionId: pane.sessionId, candidates: fresh });
    },
    lookupPath,
    openPath: (paneId, resolved, event) => {
      const pane = panesHost?.get(paneId);
      if (!pane) return;
      const how = chooseOpenAction(resolved, event);
      client?.send({ t: 'open-path', sessionId: pane.sessionId, path: resolved.candidate, how });
      setStatus(`${describeOpen(how)} ${resolved.absolute}`, 'ok');
      setTimeout(() => setStatus('', 'hidden'), 1600);
    },
    openUrl: (url) => {
      // Scheme allowlist. Anything else stays inert text. See docs/05-security.md §4.
      if (/^https?:\/\//i.test(url)) void chrome.tabs.create({ url });
    },
    modifierHeld: () => cmdHeld,
  });

  splitView = new SplitView({
    root,
    paneElement: (paneId, sessionId) => panesHost?.element(paneId, sessionId) as HTMLElement,
    onRatioChange: (paneId, ratio) => {
      if (workspaceId) client?.send({ t: 'set-ratio', workspaceId, paneId, ratio });
    },
    onFocusPane: (paneId) => panesHost?.focus(paneId),
    paneTitle,
    onClosePane: (paneId) => {
      splitView?.focus(paneId);
      closeFocused();
    },
    /**
     * The dots open the pane's own menu, which is the same menu a right click gives.
     *
     * Not a second, smaller menu built for the bar. Everything that can be done to a pane is in
     * that one already, and a bar with its own three entries would be a list to keep in step
     * with a list that is already right.
     */
    onPaneMenu: (paneId, x, y) => panesHost?.get(paneId)?.controller.openMenuAt(x, y),
    onPaneResized: (paneId) => {
      const size = panesHost?.fit(paneId);
      if (size && workspaceId && attached) {
        client?.send({ t: 'resize-pane', workspaceId, paneId, cols: size.cols, rows: size.rows });
      }
    },
  });
}

/**
 * The last few colors, per use, held in memory as well as in storage.
 *
 * A right-click menu is built and measured synchronously, so it cannot wait on a storage read to
 * know what color the swatch should be. This is refreshed whenever one is used and read once at
 * startup, and being briefly out of date costs nothing: the worst case is a swatch showing the
 * previous color for one menu.
 */
const recentColors: Record<ColorUse, string[]> = {
  title: [DEFAULT_COLOR.title],
  marker: [DEFAULT_COLOR.marker],
  highlight: [DEFAULT_COLOR.highlight],
};

function refreshRecentColors(): void {
  for (const use of ['title', 'marker', 'highlight'] as const) {
    void loadRecentColors(use).then((list) => (recentColors[use] = [...list]));
  }
}

function useColor(use: ColorUse, color: string): void {
  recentColors[use] = [color, ...recentColors[use].filter((c) => c !== color)].slice(0, 5);
  void rememberColor(use, color);
}

/** Conversations the person has taken out of the resume list. */
const hiddenResumes = new Set<string>();

function loadHiddenResumes(): void {
  void chrome.storage.local
    .get('tabterm.hiddenResumes')
    .then((stored) => {
      const list: unknown = stored['tabterm.hiddenResumes'];
      if (Array.isArray(list)) {
        for (const id of list) if (typeof id === 'string') hiddenResumes.add(id);
      }
      /**
       * Answered even when there is nothing stored, which is the ordinary case.
       *
       * Returning early left the start screen waiting for an answer that was never coming, and
       * it draws once it has what it asked for: on a profile that had never hidden a resume row,
       * the whole screen waited for the deadline instead. "Nothing hidden" is an answer.
       */
      launcher?.setHiddenResumes([...hiddenResumes]);
    })
    .catch(() => launcher?.setHiddenResumes([...hiddenResumes]));
}

function buildLauncher(): void {
  const overlay = document.getElementById('overlays') as HTMLElement;

  launcher = new Launcher({
    root: overlay,
    onCheckFolder: (path) => client?.send({ t: 'check-folder', path }),
    onCreateFolder: (path) => client?.send({ t: 'create-folder', path }),
    onChooseDir: (path) => {
      // Send a real `cd` rather than restarting the session: the shell you are already in is
      // the one you want, just somewhere else.
      sendToFocusedPane(`cd ${quote(path)}\r`);
      launcher?.dismiss();
    },
    onReorderTemplates: (ids) => {
      /**
       * The list is stored in the order it is shown, so the numbering follows the order.
       *
       * Nothing else has to know: the shortcut is the position in the list, and the list is
       * what was dragged into place.
       */
      void loadTemplates().then(async (existing) => {
        const byId = new Map(existing.map((t) => [t.id, t]));
        const next = ids.flatMap((id) => byId.get(id) ?? []);
        for (const t of existing) if (!ids.includes(t.id)) next.push(t);
        await saveTemplates(next);
        launcher?.setTemplates(next);
      });
    },
    onSaveTemplate: (template) => {
      void loadTemplates().then(async (existing) => {
        // Edited in place when it is one that already exists, so editing does not move it to
        // the end and renumber everything after it.
        const at = existing.findIndex((t) => t.id === template.id);
        const next =
          at >= 0
            ? existing.map((t) => (t.id === template.id ? template : t))
            : [...existing.filter((t) => t.name !== template.name), template];
        await saveTemplates(next);
        launcher?.setTemplates(next);
        setStatus(`Saved "${template.name}"`, 'ok');
        setTimeout(() => setStatus('', 'hidden'), 2500);
      });
    },
    onDeleteTemplate: (id) => {
      void loadTemplates().then(async (existing) => {
        const next = existing.filter((t) => t.id !== id);
        await saveTemplates(next);
        launcher?.setTemplates(next);
      });
    },
    onRunTemplate: (template, path) => {
      /**
       * Build the layout, then stage each command in its pane.
       *
       * Staged rather than run, the same as every other saved thing here. A template that
       * executed on click is how somebody deploys by mis-clicking a menu.
       */
      pendingTemplate = template;
      // Remembered for the title, with the shape it had: an arrangement that has lost a pane is
      // no longer this template, and should stop being called by its name.
      openedTemplate = template.name;
      openedTemplatePanes = template.panes;
      layoutRequestedHere = true;
      const size = panesHost?.fit(splitView?.focused ?? '') ?? attachSize();
      client?.send({
        t: 'create-layout',
        /**
         * The folder in the box, not the one the template was saved in.
         *
         * A template is an arrangement and a set of commands; where to apply it is what the
         * path box is for and what somebody has just finished typing. Opening in the folder it
         * happened to be saved from meant a template was only ever usable in one project.
         */
        path: path || template.path,
        panes: template.panes,
        direction: 'horizontal',
        shape: template.shape,
        // A template saved with a written shape uses it; older ones keep their fixed shape.
        ...(template.layout ? { layout: template.layout } : {}),
        createIfMissing: true,
        ...size,
      });
      launcher?.dismiss();
    },
    onDropRejected: () => {
      setStatus('That drop carried no path. Finder cannot provide one, see the docs.', 'warn');
      setTimeout(() => setStatus('', 'hidden'), 4000);
    },
    onCreateLayout: (path, panesWanted, direction, shape) => {
      layoutRequestedHere = true;
      const size = panesHost?.fit(splitView?.focused ?? '') ?? attachSize();
      client?.send({
        t: 'create-layout',
        path,
        panes: panesWanted,
        direction,
        ...(shape ? { shape } : {}),
        createIfMissing: true,
        ...size,
      });
      launcher?.dismiss();
    },
    onPinDir: (path, pinned) => {
      client?.send({ t: 'pin-dir', path, pinned });
      client?.send({ t: 'list-launcher' });
    },
    onForgetDir: (path) => {
      client?.send({ t: 'forget-dir', path });
      client?.send({ t: 'list-launcher' });
    },
    onInspectProject: (path) => client?.send({ t: 'inspect-project', cwd: path }),
    onDecideProjectTrust: (info, decision) => {
      client?.send({
        t: 'decide-project-trust',
        path: info.path,
        contentHash: info.contentHash,
        decision,
      });
      // Re-read rather than assume: the daemon is the authority on what the decision means,
      // and the file may have changed between the prompt and the click.
      client?.send({ t: 'inspect-project', cwd: info.path.replace(/\/[^/]+$/, '') });
    },
    onCompletePath: (partial) => client?.send({ t: 'complete-path', partial }),
    onOpenSession: (session) => {
      /**
       * Go to the session, wherever it is.
       *
       * A session already shown in a tab is focused rather than attached again, because two
       * views of one terminal is something people create by accident and never on purpose.
       *
       * The tab doing the clicking is deliberately left alone when the session lives elsewhere.
       * Dismissing its start screen would reveal its own empty terminal at the same moment
       * focus moves away, so coming back to it later looks exactly like the click opened a
       * second copy. It did not; this tab simply stopped showing the list.
       */
      if (!session.workspaceId) return;

      /**
       * Taken over here when this tab has nothing in it. Never opened beside it.
       *
       * This has been reported twice. A session running in the background was handed to the
       * service worker, which opens the workspace in a **new** tab, leaving the tab that was
       * clicked in sitting on a bare shell in the home directory. Two tabs for one action, and
       * the one you were looking at is the useless one.
       *
       * Navigating is what takes it over. The reattach path already knows how to restore a
       * workspace into a tab, so this borrows it whole rather than growing a second way to do
       * the same thing. The shell this tab was holding is untouched and never used, so the
       * policy that clears untouched panes away takes it in its own time.
       */
      const spare = thisTabIsUnused();
      if (!session.attached && spare) {
        location.href = chrome.runtime.getURL(`terminal.html?workspace=${session.workspaceId}`);
        return;
      }

      /**
       * Already open somewhere, so that tab is brought forward and **this one goes**.
       *
       * Leaving it was the previous behavior, on the reasoning that dismissing its start screen
       * would reveal its own empty terminal at the moment focus moved away, which reads as a
       * second copy of the session. Closing it answers that better: there is no tab left to be
       * confused by. Only ever a tab nobody has used.
       */
      void chrome.runtime.sendMessage({
        t: 'tabterm:focus-workspace',
        workspaceId: session.workspaceId,
        attachHere: !session.attached,
      });
      if (!session.attached) launcher?.dismiss();
      if (spare) {
        // After the focus message, so the tab being switched to is already in front.
        setTimeout(() => window.close(), 120);
      }
    },
    onCloseSession: (session) => {
      client?.send({ t: 'kill-session', sessionId: session.sessionId });
      // A tab showing a session that no longer exists is a tab showing an apology, so it goes
      // with the session it was showing.
      if (session.workspaceId) {
        void chrome.runtime.sendMessage({
          t: 'tabterm:close-workspace-tab',
          workspaceId: session.workspaceId,
        });
      }
      setTimeout(() => client?.send({ t: 'list-live-sessions' }), 400);
    },
    onRestore: (workspaceId, replayCommands) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? attachSize();
      client?.send({ t: 'restore-workspace', workspaceId, replayCommands, ...size });
      launcher?.dismiss();
    },
    onReadAgentSession: (sessionId) => {
      client?.send({ t: 'read-agent-session', sessionId, limit: 14 });
    },
    onForgetRestorable: (workspaceId) => {
      client?.send({ t: 'forget-restorable', workspaceId });
      client?.send({ t: 'list-restorable' });
    },
    onOpenServer: (port) => {
      void chrome.runtime.sendMessage({ t: 'tabterm:open-local', port });
    },
    onAttachServer: (server) => {
      // Focus the tab that owns the workspace rather than opening a second view of it.
      if (server.workspaceId && server.workspaceId === workspaceId) {
        launcher?.dismiss();
        return;
      }
      const url = chrome.runtime.getURL(
        server.workspaceId ? `terminal.html?workspace=${server.workspaceId}` : 'terminal.html',
      );
      void chrome.tabs.create({ url, active: true });
    },
    onStopServer: (server, restart) => {
      client?.send({ t: 'stop-server', sessionId: server.sessionId, restart });
      // Ask again shortly, so the row disappears once it has actually stopped rather than
      // sitting there claiming a server that is gone.
      setTimeout(() => client?.send({ t: 'list-servers' }), 2500);
    },
    /**
     * A conversation dismissed from the list stays dismissed.
     *
     * In extension storage rather than the daemon: this is a view of somebody's own history,
     * and hiding a row is a statement about what they want to see rather than about the
     * conversation, which is still on disk and still resumable from the agent's own tools.
     */
    onHideResume: (sessionId) => {
      hiddenResumes.add(sessionId);
      void chrome.storage.local.set({ 'tabterm.hiddenResumes': [...hiddenResumes] });
    },
    onResumeAgent: (session) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? attachSize();
      // Resumed into this tab, not beside it. Asked for here, so it belongs here.
      if (thisTabIsUnused()) layoutRequestedHere = true;
      client?.send({
        t: 'resume-agent',
        sessionId: session.sessionId,
        cwd: session.cwd,
        agent: session.agent,
        ...size,
      });
      launcher?.dismiss();
    },
    onOpenProject: (path) => {
      const size = panesHost?.fit(splitView?.focused ?? '') ?? attachSize();
      client?.send({ t: 'launch-project-template', cwd: path, ...size });
      launcher?.dismiss();
    },
    onWantsTerminal: () => {
      // The shell under the start screen takes the keyboard, so typing is never going nowhere.
      const paneId = splitView?.focused ?? panesHost?.all[0]?.paneId;
      if (paneId) panesHost?.focus(paneId);
    },
    onDismiss: () => {
      /**
       * Written down here, because this is the one place every dismissal passes through.
       *
       * Whatever the reason, leaving the start screen means this tab has started something, and
       * a refresh must not put it back. Marking it at each of the dozen places that dismiss it
       * would be a dozen chances to forget.
       */
      rememberLaunched();
      // The terminal takes the whole window back. Its size genuinely changes, so the shell is
      // told, and it redraws into the space it now has.
      root.classList.remove('panel-open');
      // The strip is gone, so the height it had grown to must not survive it.
      document.documentElement.style.removeProperty('--strip-height');
      refitAllPanes();
      panesHost?.focus(splitView?.focused ?? '');
    },
  });

  palette = new Palette({
    root: overlay,
    onQuery: (query, scope, offset) => {
      // Rebuilt per query, because which actions make sense depends on the layout right now.
      palette?.setActions(paletteActions());
      const sessionId = focusedSessionId();
      client?.send({
        t: 'list-history',
        query,
        scope,
        offset,
        limit: 100,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onPaste: (text) => sendToFocusedPane(text),
    // A separate callback from paste, so running is never something the paste path can do.
    onRun: (text) => sendToFocusedPane(`${text}\r`),
    onOpenDir: (path) => sendToFocusedPane(`cd ${quote(path)}\r`),
    onCopy: (text) => void navigator.clipboard.writeText(text),
    onSave: (text) => client?.send({ t: 'save-item', title: text.slice(0, 60), body: text }),
    onSaveScoped: (text, scopeToProject) => {
      const sessionId = focusedSessionId();
      client?.send({
        t: 'save-item',
        title: text.slice(0, 60),
        body: text,
        scopeToProject,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onPinSaved: (id, pinned) => client?.send({ t: 'pin-saved', id, pinned }),
    onUseSaved: (id) => client?.send({ t: 'use-saved', id }),
    onDeleteSaved: (id) => client?.send({ t: 'delete-saved', id }),
    onEditAction: editAction,
    onDeleteAction: deleteAction,
    onMerge: (sessionId) => {
      const targetPaneId = splitView?.focused;
      if (!targetPaneId || !workspaceId) return;
      client?.send({
        t: 'merge-into',
        workspaceId,
        targetPaneId,
        sessionId,
        direction: 'horizontal',
      });
    },
    onClose: () => panesHost?.focus(splitView?.focused ?? ''),
  });

  /**
   * Filled the moment it exists, rather than only when something next asks it to be.
   *
   * The list used to be set from a query and from whatever arrived afterwards, so a palette
   * opened before any of that had happened showed nothing at all. Whether it did depended on
   * timing, which is the definition of a list that is sometimes empty for no reason.
   */
  palette.setActions(paletteActions());

  /**
   * A tab that has already started something has no start screen, from the first frame.
   *
   * Not merely left undrawn: rendering unhides the element, and the start screen renders
   * whenever the daemon sends it something to list, so a tab reloading into work would have it
   * appear a second later regardless of what anything decided at startup. Dismissed here, once,
   * which is also what takes down the keys it binds.
   */
  if (hasLaunched()) launcher.dismiss();
  /**
   * A tab with no workspace is a new tab, and a new tab always shows the start screen.
   *
   * Known from the URL, before anything has been asked of the daemon, which is what makes this
   * safe: a tab reattaching to work has a workspace in its URL and never draws any of this, not
   * even for a moment. The alternative, guessing from what is on screen, is exactly the guess
   * that used to put the start screen over somebody's session.
   */
  else if (!new URL(location.href).searchParams.get('workspace')) {
    root.classList.add('panel-open');
    launcher.renderPlaceholder();
  }
}

const quote = quotePath;

/** The session behind the focused pane, which is what a scoped search resolves against. */
/**
 * The memory mode's frontend half.
 *
 * Defaults match `balanced`, so a page that has not heard from the daemon yet behaves the way
 * the shipped configuration does rather than the most aggressive one.
 */
let memorySettings = {
  rendererUnloadMs: 120_000,
  faviconWhileHidden: true,
  scrollbackLines: 10_000,
};
let rendererTimer: ReturnType<typeof setTimeout> | undefined;
/** Set once the page is wired up. See its definition for why a check needs to call it. */
let lookedAtTab: () => void = () => undefined;

/**
 * Release renderers after a tab has been hidden for a while.
 *
 * Not immediately: flicking between two tabs is common, and tearing down a WebGL context on
 * every switch would cost more than it saves. The delay is what the memory mode sets.
 */
/**
 * A hidden tab gives its accelerated renderers back.
 *
 * Not only to save memory, which is what the delay was chosen for. A browser keeps a limited
 * number of these and takes the oldest away when something else wants one, so a tab nobody is
 * looking at holding onto one costs a tab somebody **is** looking at: the pane that loses it
 * falls back to drawing with DOM nodes, which is fine for a prompt and slow for a tab holding an
 * agent's output. With a dozen terminal tabs open, waiting two minutes each is how a context ends
 * up being taken rather than given.
 *
 * So a hidden tab gives them up promptly, and the full delay is kept for the case the setting is
 * really about: coming straight back to a tab you glanced away from.
 */
const RENDERER_HANDBACK_MS = 4000;

function scheduleRendererRelease(): void {
  clearTimeout(rendererTimer);
  const wait = Math.min(memorySettings.rendererUnloadMs, RENDERER_HANDBACK_MS);
  rendererTimer = setTimeout(() => {
    if (document.visibilityState === 'hidden') panesHost?.releaseRenderers();
  }, wait);
}

function focusedSessionId(): string | undefined {
  const paneId = splitView?.focused;
  const pane = paneId ? panesHost?.get(paneId) : undefined;
  return pane?.sessionId;
}

function sendToFocusedPane(text: string): void {
  const paneId = splitView?.focused;
  const pane = paneId ? panesHost?.get(paneId) : undefined;
  if (!pane) return;
  client?.write(pane.streamId, new TextEncoder().encode(text));
  // Same rule as typing: pasting a command leaves the panel up, running one takes it away.
  if (submitsCommand(text)) launcher?.dismiss();
}

/**
 * Whether this input submits a command rather than editing one.
 *
 * A carriage return is what a shell treats as "run it", which is exactly the moment the user
 * has stopped choosing and started working.
 */
/**
 * Re-measure every pane after the available space changes.
 *
 * A terminal that is not told it grew keeps wrapping to its old width, which looks like a
 * rendering bug and is really a stale size.
 */
/**
 * Measure the pane, tell the daemon, and make a full-screen application draw itself again.
 *
 * The measure is the important half: the snapshot was written at the daemon's width and this
 * pane is whatever size the window makes it, so the two have to be reconciled before anything
 * else happens.
 *
 * The repaint is the half that makes it stay right. An application like an agent draws
 * differentially: it writes only the cells it believes changed. Once its idea of the screen and
 * ours have diverged, nothing brings them back together, because the parts that are wrong are
 * parts it has no reason to touch. A size change is the one thing every terminal application
 * treats as "you know nothing, draw it all again", so the size is nudged by a row and put back.
 * It is what tmux does when you reattach, and for the same reason.
 */
function repaintAfterRestore(paneId: string, screen: string): void {
  // Null means the pane could not be measured. Nudging a size nobody knows is how the flicker
  // started: see `fit`.
  const size = panesHost?.fit(paneId);
  if (!size || !workspaceId) return;
  /**
   * Once for a pane, not once per snapshot.
   *
   * A snapshot can arrive again for the same pane: a resync, a reattach, anything that makes the
   * daemon resend one. Nudging every time is a size change every time, and the nudge itself
   * changes the size, so it kept its own cause alive. That is a terminal that flickers rather
   * than one that repaints.
   */
  if (nudgedPanes.has(paneId)) return;
  nudgedPanes.add(paneId);
  /**
   * Only for a screen that had something on it.
   *
   * A session created a moment ago gets a snapshot too, and it is empty: there is nothing to
   * repaint and the nudge is two size changes arriving exactly while a template is waiting for a
   * prompt to type its command into. That broke a template's command outright, which is a good
   * deal worse than the thing this exists to fix.
   */
  if (screen.trim() === '') return;
  askForSize(paneId, { cols: size.cols, rows: Math.max(1, size.rows - 1) }, 'nudge-down');
  setTimeout(() => {
    // Measured again, and only sent if it really was measured.
    const now = panesHost?.fit(paneId);
    if (now) askForSize(paneId, now, 'nudge-back');
  }, 60);
}

/**
 * The size to attach with, before any pane exists to measure.
 *
 * Attaching announced 80 by 24 and the daemon believed it: sessions were resized to that, their
 * screens were serialized at that width, and the result was written into a pane four times
 * wider. A full-screen application came back as fragments of several moments overlapping.
 *
 * Estimated from the window and a character cell, which is exact for the common case of one
 * pane and close enough for a split that the pane's own measurement, arriving a moment later,
 * is a small correction rather than a different screen. A wrong guess is only ever wrong for
 * that moment; 80 by 24 was wrong for the whole reattach.
 */
function attachSize(): { cols: number; rows: number; estimated?: true } {
  const measured = panesHost?.all[0]?.controller.fit();
  if (measured && measured.cols > 1 && measured.rows > 1) return measured;
  // A cell from the terminal's own font metrics when there is one, and a sane default when not.
  const cell = panesHost?.all[0]?.controller.cellSize();
  const width = cell?.width ?? 7;
  const height = cell?.height ?? 17;
  const usableWidth = Math.max(200, window.innerWidth - 24);
  const usableHeight = Math.max(120, window.innerHeight - 24);
  /**
   * Said to be a guess, because it is one.
   *
   * A page that has just loaded has no pane with a box, so this works a size out from the window
   * and the answer is systematically too big: it does not know about the gap the launcher takes,
   * the border, or the scrollbar. Measured against the real thing on this machine it was 212 by
   * 47 where the truth was 195 by 44.
   *
   * That was being applied. Every tab open resized the terminal to the guess and then to the
   * measurement a tenth of a second later, which for a shell is nothing and for a full-screen
   * program is a complete redraw at the wrong width followed by another at the right one. On
   * every single tab open. The daemon ignores a guess for a terminal that already has a size.
   */
  return {
    cols: Math.max(20, Math.min(500, Math.floor(usableWidth / Math.max(1, width)))),
    rows: Math.max(5, Math.min(300, Math.floor(usableHeight / Math.max(1, height)))),
    estimated: true,
  };
}

/**
 * The size each pane last asked for, which is how "we were overruled" is told from "we agreed".
 *
 * One PTY has one size and the daemon picks the smallest across the views attached to it. A view
 * only needs to change its grid when the answer is not what it asked for.
 */
const requestedSizes = new Map<string, { cols: number; rows: number }>();
/** Panes being resized to follow the daemon, whose own resize event is not a new request. */
const followingSize = new Set<string>();
/** Panes whose restored screen has already been repainted once. See `repaintAfterRestore`. */
const nudgedPanes = new Set<string>();

/**
 * Ask the daemon for a size, and record why.
 *
 * The reason is carried because a size on its own does not say where it came from, and every
 * flicker so far has been one path asking for something another path had just decided. When the
 * detector reports a storm it reports the reasons with it, which is the difference between
 * knowing that a pane is resizing and knowing what keeps resizing it.
 */
function askForSize(paneId: string, size: { cols: number; rows: number }, why: string): void {
  if (!workspaceId) return;
  requestedSizes.set(paneId, size);
  noticeResize(paneId, size, why);
  client?.send({ t: 'resize-pane', workspaceId, paneId, ...size });
}

/**
 * The sizes the daemon said it applied, most recent last.
 *
 * Kept only so that the effect of a resize can be seen from the page at all. Bounded, because it
 * is a window on the recent past and not a history.
 */
const sessionSizes: { paneId: string; cols: number; rows: number }[] = [];
const SESSION_SIZE_MEMORY = 40;

/**
 * Sizes asked for recently, so a pane that has started resizing itself in a loop says so.
 *
 * A terminal caught in one is visible to the person watching it and to nothing else: by the time
 * it is reported the evidence is gone, and asking somebody to open a console while it is
 * happening is asking them to do the debugging. Every case of it so far has been a measurement
 * feeding its own input, and the useful evidence is the sequence of sizes, which is exactly what
 * this keeps.
 *
 * It reports once and then stays quiet for a while, because a log line per resize would be the
 * same storm written down.
 *
 * What counts as one is in `resize-storm.ts`, and it is not a count. Counting cannot tell a loop
 * from a window being dragged, and the first version tried: it wanted six changes a second while
 * the flicker being reported was about five, so it sat just above the fault it was watching for.
 */
const recentSizes = new Map<string, { at: number; cols: number; rows: number; why: string }[]>();
let lastResizeReport = 0;
const RESIZE_REPORT_GAP_MS = 60_000;

function noticeResize(paneId: string, size: { cols: number; rows: number }, why: string): void {
  const now = Date.now();
  const seen = recordChange(recentSizes.get(paneId) ?? [], { at: now, ...size, why });
  recentSizes.set(paneId, seen);
  if (!isResizeStorm(seen, now) || now - lastResizeReport < RESIZE_REPORT_GAP_MS) return;
  lastResizeReport = now;
  client?.send({
    t: 'note',
    event: 'resize-storm',
    detail: {
      paneId: paneId.slice(0, 8),
      changes: seen.length,
      distinct: distinctSizes(seen),
      windowMs: HISTORY_MS,
      sizes: seen
        .slice(-8)
        .map((s) => `${s.why}:${String(s.cols)}x${String(s.rows)}`)
        .join(' '),
      panes: panesHost?.all.length ?? 0,
      panelOpen: root.classList.contains('panel-open'),
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    },
  });
}

function refitAllPanes(): void {
  for (const pane of panesHost?.all ?? []) {
    const size = panesHost?.fit(pane.paneId);
    if (size) askForSize(pane.paneId, size, 'refit');
  }
}

/**
 * Measure again whenever the tab comes back to life.
 *
 * A laptop closed overnight wakes with its terminals drawn into a corner of the pane, as though
 * the window were a quarter of its size, and dragging the window fixes it. The element's box
 * never changed, so the `ResizeObserver` had nothing to report; what went stale was xterm's own
 * measurement of a character cell, taken while the display was off or the renderer released.
 *
 * There is nothing to detect and no event that says "your measurements are wrong", so it is
 * simply redone at every moment the tab could have missed one: becoming visible, regaining
 * focus, and coming back from the back/forward cache. Measuring costs a layout read and is done
 * a handful of times a day.
 */
function installRefitOnWake(): void {
  let pending = 0;
  let hiddenSince = 0;

  const remeasure = (): void => {
    clearTimeout(pending);
    // One frame later, so the browser has finished whatever it was doing to the window first.
    pending = window.setTimeout(() => {
      for (const pane of panesHost?.all ?? []) pane.controller.restoreRenderer();
      refitAllPanes();
      /**
       * A tab left alone for a long time is asked to draw itself again.
       *
       * A full-screen program draws differentially and repaints in full only when it is told the
       * size changed. If its idea of the width and the terminal's ever part company, nothing
       * brings them back: the size is already correct, so no resize is sent, so nothing repaints.
       * A tab opened after five hours showed an agent drawn across a third of the window with
       * the rest blank, and refreshing was the only way out.
       *
       * The threshold is what keeps this from being a nuisance. Flicking between two tabs is
       * constant, and repainting an agent every time would be its own defect; a tab nobody has
       * looked at for a minute is a different thing, and that is when the picture can have gone
       * stale without anybody being told.
       */
      const away = hiddenSince;
      hiddenSince = 0;
      if (!shouldRedrawAfterAway(away, Date.now())) return;
      for (const pane of panesHost?.all ?? []) askForRedraw(pane.paneId);
    }, 60);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') remeasure();
    else if (hiddenSince === 0) hiddenSince = Date.now();
  });
  window.addEventListener('focus', remeasure);
  window.addEventListener('pageshow', remeasure);
}

/**
 * Ask whatever is running in a pane to draw itself again.
 *
 * A size change is the one thing every terminal application treats as "you know nothing, draw it
 * all", so the size is nudged by a row and put back. The same trick a multiplexer uses on
 * reattach, and the only way to clear a divergence that has already happened.
 */
function askForRedraw(paneId: string): void {
  const size = panesHost?.fit(paneId);
  if (!size || !workspaceId) return;
  askForSize(paneId, { cols: size.cols, rows: Math.max(1, size.rows - 1) }, 'redraw-down');
  setTimeout(() => {
    const now = panesHost?.fit(paneId);
    if (now) askForSize(paneId, now, 'redraw-back');
  }, 60);
}

/**
 * The strip under the start screen grows upward when a command needs more than one line.
 *
 * It was a fixed 4.5rem, so a long command scrolled inside it: the prompt went off the top and
 * what was being typed had no visible beginning. Growing rather than scrolling keeps the whole
 * of it in view, which is the entire reason the strip is there.
 *
 * Bounded, because this is a strip under a start screen and not the terminal itself. Past the
 * cap it scrolls again, which is the right behavior for something genuinely long.
 */
function growStripToFit(): void {
  if (!root.classList.contains('panel-open')) return;
  const pane = panesHost?.all[0];
  if (!pane) return;
  const term = pane.controller.term;
  const buffer = term.buffer.active;

  /**
   * How many rows the line being typed needs, counted from **what was typed**.
   *
   * Two earlier attempts read the screen, and the screen is the one thing that cannot answer
   * this. Counting non-blank rows was wrong after a reload, when the viewport is full of a
   * restored screen. Walking xterm's wrap flags was wrong for the case this exists for: in a
   * three row terminal zsh does not wrap a long line at all, it **truncates the display** and
   * draws `>....` to say so, so there are no wrapped rows to find and the box never grew. That
   * is the `> ....` in the report, and the repeated prompt lines are the same shell redrawing.
   *
   * The characters are already counted, by the buffer that watches for abbreviations, and they
   * are counted before the shell sees them. It resets on Return, which is exactly when this
   * should reset too.
   */
  const typed = inputLine.length;
  /**
   * Where the prompt ends, learned while the line is empty.
   *
   * The cursor sits immediately after the prompt when nothing has been typed, so this is exact
   * and costs nothing. Without it a long prompt like `(base) halvis82@Halvor-Mac ~ %` is nearly
   * a third of a row that the arithmetic does not know about.
   */
  /**
   * Nothing typed means nothing to grow for, and the box goes back to one line.
   *
   * Returning here is the important half. The prompt's width is learned from where the cursor
   * sits when the line is empty, and while a command is running the cursor is wherever the
   * output put it: a cursor far to the right made the arithmetic ask for a second row, the next
   * chunk moved it back, and the box grew and shrank on every chunk of output. Thousands of size
   * changes a second, which is a terminal that flickers and a page that feels laggy because it
   * is laying itself out constantly.
   *
   * So the cursor is only read as a prompt width when the shell is **at** a prompt with an empty
   * line, which is exactly when it means that. Output is not an instruction to resize anything.
   */
  if (typed === 0) {
    promptColumns = Math.min(buffer.cursorX, Math.max(1, term.cols - 1));
    resetStrip();
    keepLauncherAbovePane(pane);
    scrollCursorSoon(term);
    return;
  }
  const inputRows = rowsNeeded(promptColumns, typed, term.cols);

  /**
   * Past this it stops being a strip and becomes the terminal.
   *
   * A box that keeps growing eventually runs out of window and starts truncating what is being
   * typed, which is the one thing it exists to show. At that point the start screen is in the
   * way: what somebody is doing is using the terminal, so they get the terminal, in the folder
   * it was already in.
   */
  const lineHeight = pane.element.clientHeight / Math.max(1, term.rows);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

  const max = Math.round(window.innerHeight * 0.4);
  /**
   * The most rows this box may ever show, which is the smaller of two limits.
   *
   * Ten, because past that it has stopped being a hint under a menu. And whatever fits in the
   * share of the window a strip is allowed, because on a short window ten rows is most of the
   * screen. The height cap was applied on its own, so on a small window the box stopped growing
   * at eight rows and the line went on getting longer behind a shell that had started truncating
   * it. Growing to a limit and then quietly showing less than was typed is the failure this is
   * supposed to prevent.
   */
  const roomForRows = Math.floor((max - STRIP_PADDING) / lineHeight);
  const maxRows = Math.max(MIN_STRIP_ROWS, Math.min(MAX_STRIP_ROWS, roomForRows));

  /**
   * Past that it stops being a strip and becomes the terminal.
   *
   * What somebody is doing at that point is using the terminal, so they get the terminal, in the
   * folder it was already in, with what they have typed still on the line. The alternative is a
   * box that cannot show the line it exists to show.
   */
  if (inputRows + 1 > maxRows) {
    launcher?.dismiss();
    return;
  }

  const rows = Math.max(MIN_STRIP_ROWS, inputRows + 1);
  const wanted = Math.round(rows * lineHeight) + STRIP_PADDING;
  const height = Math.max(MIN_STRIP_PX, Math.min(max, wanted));

  const current =
    Number(document.documentElement.style.getPropertyValue('--strip-height').replace('px', '')) ||
    MIN_STRIP_PX;

  /**
   * It only ever grows, until the line being typed is gone.
   *
   * This is the fix for a box that shook. Changing the height changes how many rows the terminal
   * has, which can add or remove xterm's scrollbar, which changes how many **columns** there
   * are, which changes where the line wraps, which changes the number of rows it needs, which
   * changes the height. A measurement that feeds its own input oscillates, and damping it only
   * makes the oscillation slower.
   *
   * Growing in one direction cannot loop. It goes back to one line when the line being typed is
   * gone, which is the branch below.
   */
  if (height > current) {
    document.documentElement.style.setProperty('--strip-height', `${String(height)}px`);
    refitAllPanes();
  } else if (inputRows === 1 && current > MIN_STRIP_PX) {
    /**
     * And back to one line when the line is gone, which is not the same as shrinking.
     *
     * The condition is "the input occupies exactly one row", not "fewer rows than before". That
     * is far from the boundary where the oscillation lives: a line that fits in one row at this
     * height still fits in one row at the smallest one, so there is nothing to bounce between.
     * Backspacing through a long command puts the box back rather than leaving a gap.
     */
    resetStrip();
  }

  /**
   * Where the start screen must stop, measured from the pane rather than computed.
   *
   * It was `strip height plus a few pixels`, which assumes the strip begins exactly that far
   * from the bottom of the window. It does not: the terminal has padding of its own below it,
   * so the start screen's opaque edge sat two pixels over the pane's top border.
   */
  keepLauncherAbovePane(pane);
  scrollCursorSoon(term);
}

/**
 * Where the start screen must stop, measured from the pane rather than computed.
 *
 * It was `strip height plus a few pixels`, which assumes the strip begins exactly that far from
 * the bottom of the window. It does not: the terminal has padding of its own below it, so the
 * start screen's opaque edge sat two pixels over the pane's top border.
 */
function keepLauncherAbovePane(pane: { element: HTMLElement }): void {
  const top = pane.element.getBoundingClientRect().top;
  if (top <= 0) return;
  document.documentElement.style.setProperty(
    '--launcher-bottom',
    `${String(Math.round(window.innerHeight - top + 4))}px`,
  );
}

/**
 * Put the line being typed in view once the writing has finished.
 *
 * **The cursor, not the bottom of the buffer.** Those are the same place while somebody is typing
 * and are not after a reload: the screen that comes back is the session's whole twenty-four row
 * screen, with the prompt on the first line and blanks under it, so scrolling to the bottom of it
 * showed two blank lines. That is the box reported three times as "the prompt is gone".
 *
 * Deferred, because xterm parses what it is given on its own schedule, so a scroll issued in the
 * same turn as a write happens before the content has landed. Coalesced, because this runs on
 * every chunk and a scroll per chunk is a scroll per keystroke.
 */
function scrollCursorSoon(term: Terminal): void {
  clearTimeout(stripScrollTimer);
  stripScrollTimer = setTimeout(() => showCursorRow(term), 40);
}

/**
 * Scroll so the row the cursor is on is the last one in view.
 *
 * `scrollToBottom` is the bottom of the buffer, which is only the same thing when nothing is
 * below the cursor. A restored screen has blank rows below it, and a two row viewport onto the
 * bottom of that shows nothing at all.
 */
function showCursorRow(term: Terminal): void {
  const buffer = term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  const top = Math.max(0, cursorLine - (term.rows - 1));
  term.scrollToLine(top);
}

/**
 * Back to one line, now that whatever was being typed is gone.
 *
 * Only ever called for an input of exactly one row, which is far from the boundary the
 * oscillation lives at: a line that fits in one row of a tall box still fits in one row of the
 * shortest one, so this cannot be the start of a bounce.
 */
function resetStrip(): void {
  if (!root.classList.contains('panel-open')) return;
  const current = Number(
    document.documentElement.style.getPropertyValue('--strip-height').replace('px', ''),
  );
  if (!current || current <= MIN_STRIP_PX) return;
  document.documentElement.style.setProperty('--strip-height', `${String(MIN_STRIP_PX)}px`);
  refitAllPanes();
}

let stripScrollTimer: ReturnType<typeof setTimeout> | undefined;
/** Coalesces asking again whether a pane still has nothing in it. See `syncPaneChoosers`. */
let chooserRecheckTimer: ReturnType<typeof setTimeout> | undefined;
/** Where the prompt ends, measured while the line is empty. See `growStripToFit`. */
let promptColumns = 0;
/**
 * The line being typed into the start screen's terminal, as long as it is one.
 *
 * One of these rather than one per pane: the start screen only ever has a single pane under it,
 * and this is only consulted while it is showing.
 */
const inputLine = new InputLine();

/** Two rows and a little padding: a prompt and the line under it. */
const MIN_STRIP_ROWS = 2;
/** Past this the strip stops being one, and the terminal takes the window. */
const MAX_STRIP_ROWS = 10;
const MIN_STRIP_PX = 72;
const STRIP_PADDING = 14;

function submitsCommand(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
}

function applyLayout(next: LayoutNode): void {
  layout = next;
  splitView?.render(next);
  const live = collectPanes(next);
  panesHost?.retain(live);
  // A pane that no longer exists must stop influencing the tab's indicator.
  paneStatus.retain(live);
  for (const id of [...paneTime.keys()]) if (!live.includes(id)) paneTime.delete(id);
  setFavicon(paneStatus.effective());
  refreshTitle();
  syncPaneChoosers();
}

function splitFocused(direction: 'horizontal' | 'vertical'): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  const size = panesHost?.fit(paneId) ?? attachSize();
  client?.send({ t: 'split-pane', workspaceId, paneId, direction, ...size });
}

/**
 * Pull the focused pane out into its own tab.
 *
 * The PTY is untouched throughout: only the layout changes and a new tab picks the session up
 * at its own workspace URL. See docs/04-session-lifecycle.md §6.
 */
function detachFocused(): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  if (layout && collectPanes(layout).length <= 1) return;
  client?.send({ t: 'detach-pane-to-tab', workspaceId, paneId });
}

/**
 * Launch an agent CLI in the current directory.
 *
 * A new native tab is the default, because that is the premise of the product: an agent
 * session is a Chrome tab like any other. A split is the secondary action.
 * See docs/09-agent-integration.md §5.
 */
function launchAgent(where: 'new-tab' | 'split'): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  const size = panesHost?.fit(paneId) ?? attachSize();
  client?.send({ t: 'launch-agent', where, workspaceId, paneId, ...size });
}

function closeFocused(): void {
  const paneId = splitView?.focused;
  if (!paneId || !workspaceId) return;
  // Closing the only pane would close the workspace, which is what closing the tab is for.
  if (layout && collectPanes(layout).length <= 1) return;
  client?.send({ t: 'close-pane', workspaceId, paneId });
}

/**
 * What the right-click menu offers for one pane.
 *
 * Asked for at the moment of the click, so it describes the pane as it is: a pane with no
 * siblings cannot be detached or closed, and saying so greyed out is clearer than an entry that
 * silently does nothing.
 *
 * Every entry targets the pane that was clicked rather than the focused one, by focusing it
 * first. Right-clicking a pane and having the action land somewhere else would be a trap.
 */
/** What a pane is currently called, read from the layout, which is where it lives. */
/**
 * The shells, which are not worth naming in a pane's bar.
 *
 * A pane sitting at a prompt is not news, and four panes all saying "zsh" is four labels that
 * distinguish nothing from each other. Anything else running is worth saying.
 */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', '-zsh', '-bash', 'login']);

/** What each session calls itself, kept per session because a tab can hold several. */
const sessionTitles = new Map<string, TitleFields>();

/**
 * What the bar on top of a pane says.
 *
 * The name somebody gave it first, because a name is chosen and everything else is inferred.
 * Then whatever is running in it, then the folder it is in, and then nothing rather than a
 * placeholder: an empty bar is honest and "Terminal" written four times is not.
 */
function paneTitle(paneId: string): string {
  const named = paneLabel(paneId).label;
  if (named !== '') return named;

  const sessionId = panesHost?.get(paneId)?.sessionId ?? '';
  const fields = sessionTitles.get(sessionId);
  const where = fields?.cwd ?? '';
  const folder = where === '' ? '' : where === launcherHome ? '~' : (where.split('/').pop() ?? '');
  /**
   * The folder, and what is running in it when that is worth saying.
   *
   * A shell sitting at a prompt is not news: four panes all saying "zsh" is four labels that
   * distinguish nothing. A folder always distinguishes something, and a process is added only
   * when it is not the shell that pane was started with.
   */
  const process = fields?.process ?? '';
  const running = process !== '' && !SHELLS.has(process) ? process : '';
  if (folder === '') return running;
  return running === '' ? folder : `${folder} \u00b7 ${running}`;
}

/**
 * Ask the daemon what every setting is, now.
 *
 * Each of these is answered once and then kept, so what the panel shows is whatever it last
 * heard. That is right while one daemon runs and wrong the moment a different one does: a daemon
 * that restarts with a value read from disk leaves the panel showing the value from before it,
 * with nothing on screen to say the two disagree. A person who has just been told their choice
 * did not stick has no reason to believe the picker at all.
 *
 * So the questions are asked again whenever the connection becomes ready, which is also what
 * happens after a restart, and not only when launcher state arrives.
 */
function askForSettings(): void {
  client?.send({ t: 'get-memory-mode' });
  client?.send({ t: 'get-notify-policy' });
  client?.send({ t: 'get-agent-hooks' });
  client?.send({ t: 'get-agent-command' });
  client?.send({ t: 'get-shell-integration' });
  client?.send({ t: 'get-scrollback-budget' });
  client?.send({ t: 'get-background-timeout' });
}

function paneLabel(paneId: string): { label: string; color?: string } {
  const walk = (node: LayoutNode): { label: string; color?: string } | null => {
    if (node.type === 'terminal') {
      if (node.paneId !== paneId) return null;
      return { label: node.label ?? '', ...(node.labelColor ? { color: node.labelColor } : {}) };
    }
    return walk(node.children[0]) ?? walk(node.children[1]);
  };
  return (layout ? walk(layout) : null) ?? { label: '' };
}

/**
 * Actions worth offering on the pane itself, from the same list the command menu draws.
 *
 * Read from `paletteActions` rather than written again, so the two cannot drift: a menu that
 * describes actions from its own copy is a second thing to keep true. The ones that open a tab of
 * their own are left out, because a right click on a pane is a question about that pane.
 */
function paneActionsForMenu(target: (run: () => void) => () => void): PaneMenuAction[] {
  /**
   * The splits are deliberately not here. The menu already has them, a few rows up, as entries
   * of its own, and reading the palette for them put a second `Split right` under the first.
   * Two rows that do the same thing is not two ways to reach it, it is a menu that looks broken.
   */
  const wanted = new Set(['agent-split', 'focus-mode']);
  const actions = paletteActions().filter((a) => wanted.has(a.id) || a.group === 'custom');
  if (actions.length === 0) return [];
  return actions.map((action, i) => ({
    label: action.title,
    // The first of them starts a group of its own, so they do not read as more clipboard items.
    ...(i === 0 ? { separated: true } : {}),
    run: target(() => action.run()),
  }));
}

function paneMenuActions(paneId: string): PaneMenuAction[] {
  const paneCount = layout ? collectPanes(layout).length : 1;
  const hasSiblings = paneCount > 1;
  const session = panesHost?.get(paneId)?.sessionId ?? '';
  const target = (run: () => void) => () => {
    splitView?.focus(paneId);
    run();
  };

  const named = paneLabel(paneId);

  return [
    {
      // A session, not a pane. The pane is the box; the name belongs to the terminal in it.
      label: named.label === '' ? 'Name session' : 'Rename session',
      // A group of its own: naming a terminal and marking a place in it are the same kind of
      // act, and neither belongs with the clipboard or with closing things.
      separated: true,
      run: () => {
        splitView?.focus(paneId);
        const pane = panesHost?.get(paneId);
        if (!pane || !workspaceId) return;
        openLabelForm({
          container: pane.element,
          placeholder: 'Name this session',
          current: named.label,
          recents: recentColors.title,
          ...(named.color ? { currentColor: named.color } : {}),
          // Drawn as it is typed. Only in this tab: nothing is sent until Save, so an abandoned
          // form leaves no trace anywhere else and Escape genuinely cancels.
          onPreview: (label, color) => splitView?.previewLabel(paneId, label, color),
          onSubmit: (label, color) => {
            document.querySelector('.pane-label-form')?.remove();
            if (label !== '') useColor('title', color);
            client?.send({ t: 'set-pane-label', workspaceId, paneId, label, color });
          },
          onCancel: () => {
            document.querySelector('.pane-label-form')?.remove();
            // Put back whatever the name actually is, since the preview only ever drew here.
            splitView?.previewLabel(paneId, named.label, named.color ?? '');
          },
        });
      },
    },
    {
      /**
       * A toggle, belonging to the session rather than to the tab.
       *
       * A tab can hold several terminals and one can be moved to a tab of its own later, so the
       * setting follows the terminal that finishes commands. A notification is for when you are
       * in another application; this is for when you are in another tab.
       */
      label: 'Flash the tab when a command finishes',
      enabled: session !== '',
      checked: flashing.has(session),
      run: () => {
        const on = !flashing.has(session);
        if (on) flashing.add(session);
        else flashing.delete(session);
        void setFlashing(session, on);
        if (!on) tabFlasher.stop();
      },
    },
    {
      // A landmark to scroll back to. Printed into the output rather than typed at the shell,
      // so it cannot run in whatever program is in the foreground.
      label: 'Add a marker here',
      /**
       * Not in a pane that something was launched into.
       *
       * A marker is printed into the output: full width coloured bars, written to the terminal
       * itself, with a prompt redrawn under them. That works because a shell's screen is a
       * transcript and printing into it is what everything else there does too.
       *
       * A program that draws its own screen is a different thing. It redraws over and around the
       * bars, which is the reported screenshot: two magenta stripes through the middle of a
       * conversation, belonging to nothing and removable only by clearing.
       *
       * Greyed rather than hidden, so the menu keeps its shape and the entry says the offer
       * exists but not here.
       */
      enabled: session !== '' && !panesWithCommand.has(paneId),
      run: () => {
        splitView?.focus(paneId);
        const pane = panesHost?.get(paneId);
        if (!pane) return;
        openLabelForm({
          container: pane.element,
          placeholder: 'What is this marker for',
          current: '',
          recents: recentColors.marker,
          currentColor: recentColors.marker[0] ?? DEFAULT_COLOR.marker,
          onSubmit: (label, color) => {
            document.querySelector('.pane-label-form')?.remove();
            useColor('marker', color);
            // Its own width, because the daemon's copy can be stale after a restart.
            client?.send({
              t: 'insert-marker',
              sessionId: pane.sessionId,
              label,
              color,
              cols: pane.controller.term.cols,
            });
            /**
             * And the keyboard goes back to the terminal, visibly.
             *
             * The form took it to be typed into, and removing the form leaves it nowhere. Typing
             * still reached the shell, because a keystroke with nowhere better to go is handed to
             * the focused pane, but the cursor was drawn hollow: the screen said the keyboard was
             * elsewhere while it was here.
             *
             * On the next frame, because the form is still being taken out of the document on
             * this one and focusing something that is about to be removed hands it straight back.
             */
            requestAnimationFrame(() => pane.controller.focus());
          },
          onCancel: () => {
            document.querySelector('.pane-label-form')?.remove();
            // The same on the way out. Cancelling should leave things as they were found.
            requestAnimationFrame(() => pane.controller.focus());
          },
        });
      },
    },
    { label: 'Split right', separated: true, run: target(() => splitFocused('horizontal')) },
    { label: 'Split down', run: target(() => splitFocused('vertical')) },
    {
      label: 'Move to its own tab',
      enabled: hasSiblings,
      run: target(() => detachFocused()),
    },
    /**
     * The actions, on the pane they act on.
     *
     * The same things the command menu offers, in the other place somebody looks for them. It is
     * fine for one to appear twice: a menu is a list of what can be done here, and launching an
     * agent beside this pane is exactly a thing to do here.
     */
    ...paneActionsForMenu(target),
    {
      /**
       * The same panel as Command+K and the button in the corner.
       *
       * Three ways to the same place, deliberately: a shortcut for people who know it, a button
       * for people who look, and a menu entry for people already in the menu.
       */
      ...menuToggleItem(),
      separated: true,
    },
    {
      // Reachable from the terminal as well as from the command menu and the toolbar icon.
      // A setting is usually wanted at the moment the thing it governs is annoying you.
      label: 'Settings',
      run: () => commandPanel?.openSettings(),
    },
    {
      /**
       * Always available, and with one pane it means the tab.
       *
       * Greying it out for the only pane was answering a question nobody asked. Somebody who
       * closes the only terminal in a tab means to be rid of the tab, and having to reach for
       * Chrome's own close for that is a seam where there should not be one.
       *
       * "Session", not "pane": the pane is the box, and what closing it gets rid of is the
       * terminal in it.
       */
      label: 'Close session',
      run: target(() => (hasSiblings ? closeFocused() : window.close())),
    },
    {
      // Distinct from closing: this ends the process rather than the view of it. Offered
      // because a pane holding something runaway is exactly when somebody wants it gone and
      // does not want to go looking for where that lives.
      label: 'Kill session',
      danger: true,
      enabled: session !== '',
      run: () => {
        if (session) client?.send({ t: 'kill-session', sessionId: session });
      },
    },
  ];
}

/**
 * Every pane, workspace, and session action, reachable by typing.
 *
 * This is the primary surface, not a duplicate of a control bar. A thirteen-button strip is
 * something you have to remember the layout of; a searchable list is something you can describe.
 * The hints are the keystroke where one exists, so the palette teaches the shortcut rather than
 * replacing it. See docs/06-chrome-integration.md.
 */
/**
 * What Chrome has actually bound, rather than what the manifest suggested.
 *
 * Manifest acceptance is not assignment, and a person can rebind anything, so a hardcoded hint
 * is a claim about a key that may belong to something else entirely. One said Option Shift T for
 * a command that had been rebound to Shift Command O, which is worse than saying nothing.
 *
 * Read once and kept, because `chrome.commands.getAll` is a promise and a palette is built while
 * somebody is looking at it. An empty answer means no hint, which is the honest fallback.
 */
let boundShortcuts: Record<string, string> = {};

function refreshBoundShortcuts(): void {
  void chrome.commands
    .getAll()
    .then((commands) => {
      boundShortcuts = Object.fromEntries(
        commands.flatMap((c) => (c.name && c.shortcut ? [[c.name, c.shortcut]] : [])),
      );
      palette?.setActions(paletteActions());
    })
    .catch(() => {
      /* No shortcut API is no hints, which is what an empty table already produces. */
    });
}

function paletteActions(): PaletteAction[] {
  const paneCount = layout ? collectPanes(layout).length : 1;
  /** A hint only when Chrome says the key is really bound to that command. */
  const key = (command: string): { hint: string } | Record<string, never> => {
    const shortcut = boundShortcuts[command];
    return shortcut ? { hint: shortcut } : {};
  };
  /**
   * The key this page answers to for an action, which is a different thing from Chrome's.
   *
   * Chrome's are browser-wide and live in its own settings screen. These are the page's own and
   * live in the settings panel. Reading both onto the row means one place to look for "what
   * runs this", whichever half it came from.
   */
  const pageKey = (id: string): { keys: string } | Record<string, never> => {
    const bound = pageShortcuts.find((k) => k.id === id)?.keys ?? '';
    return bound === '' ? {} : { keys: prettyKeys(bound) };
  };

  const actions: PaletteAction[] = [
    {
      id: 'split-right',
      title: 'Split right',
      ...pageKey('split-right'),
      run: () => splitFocused('horizontal'),
    },
    {
      id: 'split-down',
      title: 'Split down',
      ...pageKey('split-down'),
      run: () => splitFocused('vertical'),
    },
    {
      id: 'agent-tab',
      title: 'Launch an agent in a new tab',
      ...key('launch-agent'),
      run: () => launchAgent('new-tab'),
    },
    {
      id: 'agent-split',
      title: 'Launch an agent beside this pane',
      run: () => launchAgent('split'),
    },
    {
      id: 'new-terminal',
      title: 'New terminal tab',
      ...key('new-terminal'),
      run: () => {
        void chrome.tabs.create({ url: chrome.runtime.getURL('terminal.html'), active: true });
      },
    },
  ];

  /**
   * Actions that need more than one pane are omitted rather than shown disabled.
   *
   * Two that used to be here are gone entirely. `Maximize this pane` and `Move this pane to its
   * own tab` both act on **a** pane, and a menu opened from the keyboard cannot say which: they
   * belong in the pane's own right-click menu, where the pane is the thing you clicked. The
   * hint on the first of them, `Esc restores`, was describing a mode you had not entered yet.
   */
  if (paneCount > 1) {
    actions.push({
      id: 'close-pane',
      title: 'Close this pane',
      ...pageKey('close-pane'),
      run: () => closeFocused(),
    });
  }
  actions.push({
    id: 'merge',
    title: 'Pull a terminal in from another tab',
    run: () => {
      client?.send({ t: 'list-mergeable', workspaceId });
      palette?.openMerge();
    },
  });

  actions.push(
    {
      id: 'focus-mode',
      title: 'Fullscreen focus mode',
      run: () => {
        const paneId = splitView?.focused;
        if (paneId) void splitView?.enterFocusMode(paneId);
      },
    },
    {
      id: 'clear-history',
      title: 'Clear command history',
      run: () => client?.send({ t: 'clear-history' }),
    },
  );

  /**
   * Then the ones somebody made.
   *
   * After the built-ins rather than mixed among them, so the vocabulary stays in one place and
   * what you added to it is recognisable as yours. Each carries its own id, which is what the
   * pencil and the cross act on.
   */
  for (const custom of customActions) {
    actions.push({
      id: `custom-${custom.id}`,
      customId: custom.id,
      group: 'custom',
      title: custom.name,
      hint: describeAction(custom, knownTemplates),
      ...pageKey(actionShortcutId(custom.id)),
      run: () => runCustomAction(custom),
    });
  }

  actions.push(
    {
      id: 'new-action',
      group: 'manage',
      title: 'Make an action',
      // Says what one is for, because "make an action" describes the button and not the point
      // of it. An action is a command or a template with a name and, if you want, a key.
      hint: 'name a command or a template, then give it a key',
      run: () => showActionForm(),
    },
    {
      id: 'shortcuts',
      group: 'manage',
      title: 'Change keyboard shortcuts',
      hint: "Chrome's own, for opening a terminal from anywhere",
      // Not one of the actions: it goes somewhere rather than doing something here.
      kind: 'link',
      run: () => {
        void chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
      },
    },
  );
  return actions;
}

let commandPanel: CommandPanel | null = null;

/**
 * Timing for this tab, built from the events the page already receives.
 *
 * Per page rather than per daemon: "this session" means the terminal in front of you, and a
 * figure covering every tab you have open would answer a question nobody asked.
 */
const sessionStats = new SessionStats();

/**
 * The command panel, and the button that opens it.
 *
 * Its position and last tab are remembered in extension storage rather than in the database:
 * they are properties of a view, not of the data, and they should differ per machine.
 */
function buildCommandPanel(): void {
  const overlay = document.getElementById('overlays') as HTMLElement;

  /**
   * Opened from the toolbar icon's settings entry.
   *
   * Done here, right after the panel exists, rather than when the daemon reports something. It
   * was previously attached to a message that only arrives when a session is closed, so the
   * entry opened a tab and did nothing, which is exactly what it looked like.
   */
  const openSettingsIfAsked = (): void => {
    if (openPanelAt !== 'settings') return;
    /**
     * The start screen **stays**.
     *
     * It used to be dismissed here, which left a bare shell in the home directory behind the
     * settings panel. Closing the panel then dropped you into a terminal you never asked for,
     * in a directory you were not working in. A tab opened from the toolbar icon is a new tab
     * like any other, and a new tab shows the ways to begin.
     */
    commandPanel?.openSettings();
  };

  commandPanel = new CommandPanel({
    root: overlay,
    onPaste: (text) => sendToFocusedPane(text),
    // Return runs it; Command+Return copies it instead, for when it needs editing first.
    onRun: (text) => sendToFocusedPane(`${text}\r`),
    onCopy: (text) => void navigator.clipboard.writeText(text),
    canScrollTo: (command) => findCommandRow(command) !== null,
    onScrollTo: (command) => {
      const row = findCommandRow(command);
      // A command is worth a little context above it, the same as a landmark.
      if (row !== null) panesHost?.get(splitView?.focused ?? '')?.controller.scrollTo(row - 2);
    },
    onSearch: (query) => {
      const sessionId = focusedSessionId();
      client?.send({
        t: 'list-history',
        query,
        scope: 'global',
        limit: 100,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onKeep: (text) => client?.send({ t: 'save-item', title: text.slice(0, 60), body: text }),
    onStar: (entry) =>
      client?.send({ t: 'save-item', title: entry.command.slice(0, 60), body: entry.command }),
    onEdit: (id, changes) => client?.send({ t: 'update-saved', id, ...changes }),
    onDelete: (id) => client?.send({ t: 'delete-saved', id }),
    onCreate: (fields) => client?.send({ t: 'save-item', title: fields.title, body: fields.body }),
    onForget: (command) => {
      client?.send({ t: 'forget-command', command });
      /**
       * And ask for the list again, because nothing pushes it.
       *
       * Recents are answered when they are asked for, so removing one left the row on screen
       * until the panel was closed and reopened, which reads as the cross having done nothing.
       */
      const sessionId = focusedSessionId();
      client?.send({
        t: 'list-history',
        query: '',
        scope: 'global',
        limit: 100,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    onClose: () => {
      // The terminal takes the keyboard back, and its cursor starts blinking again.
      root.classList.remove('panel-has-keyboard');
      panesHost?.focus(splitView?.focused ?? '');
    },
    onOpen: () => {
      // Blurring the terminal is what stops its cursor: a blinking caret in a pane that is not
      // listening says the opposite of what is true.
      root.classList.add('panel-has-keyboard');
      panesHost?.blurAll();
    },
    onPlacement: (placement) => {
      void chrome.storage.local.set({ 'tabterm.panel': placement });
    },
    actions: () => paletteActions(),
    onEditAction: editAction,
    onDeleteAction: deleteAction,
    settings: () =>
      buildSettings({
        onChangeTheme: applyTheme,
        notify: () => notifyPolicy,
        onChangeNotify: (policy) => client?.send({ t: 'set-notify-policy', policy }),
        agentHooks: () => agentHooks,
        onChangeAgentHooks: (enabled) => client?.send({ t: 'set-agent-hooks', enabled }),
        agentCommand: () => agentCommand,
        onChangeAgentCommand: (command) => client?.send({ t: 'set-agent-command', command }),
        backgroundTimeout: () => backgroundTimeout,
        onChangeBackgroundTimeout: (seconds) =>
          client?.send({ t: 'set-background-timeout', seconds }),
        pageShortcuts: () => pageShortcuts,
        onRebind: (id, keys) => {
          /**
           * Refused before it is stored, with the reason.
           *
           * A key Chrome has claimed never arrives here: the page is not asked and nothing
           * fires. Somebody who bound Command W to closing a pane would watch their tab close
           * and reasonably conclude the product was broken.
           */
          const refused = whyNot(keys);
          if (refused !== null) return refused;
          const clash = pageShortcuts.find((s) => s.id !== id && s.keys === keys);
          if (clash) return `Already used by "${clash.title}".`;
          pageShortcuts = pageShortcuts.map((s) => (s.id === id ? { ...s, keys } : s));
          void saveShortcuts(pageShortcuts);
          return null;
        },
        alteredTemplates: () => alteredTemplateCount,
        onRestoreTemplates: () => {
          void loadTemplates().then(async (existing) => {
            const next = withDefaultsRestored(existing);
            await saveTemplates(next);
            launcher?.setTemplates(next);
            alteredTemplateCount = countToRestore(next);
            commandPanel?.refreshSettings();
            setStatus('Default templates restored', 'ok');
            setTimeout(() => setStatus('', 'hidden'), 2500);
          });
        },
        onRestoreSettings: () => {
          client?.send({ t: 'reset-settings' });
          void applyTheme('dark');
          setStatus('Settings restored to their defaults', 'ok');
          setTimeout(() => setStatus('', 'hidden'), 2500);
        },
        onEraseEverything: () => {
          /**
           * Everything Chrome holds for us, then everything the daemon holds.
           *
           * In that order, so a daemon that restarts mid-erase does not come back to a browser
           * still carrying the templates and preferences it was told to forget.
           */
          void (async () => {
            try {
              await chrome.storage.local.clear();
              await chrome.storage.session.clear();
            } catch {
              // Storage that will not clear is not a reason to leave the sessions running.
            }
            client?.send({ t: 'reset-everything', restartDaemon: false });
          })();
        },
        scrollbackBytes: () => scrollbackBytes,
        onChangeScrollback: (bytes) => client?.send({ t: 'set-scrollback-budget', bytes }),
        shellIntegration: () => shellIntegration,
        onChangeShellIntegration: (enabled) =>
          client?.send({ t: 'set-shell-integration', enabled }),
      }),
    stats: () => buildStats(sessionStats),
  });

  openSettingsIfAsked();

  void chrome.storage.local.get('tabterm.panel').then((stored) => {
    const placement = (stored['tabterm.panel'] as PanelPlacement | undefined) ?? DEFAULT_PLACEMENT;
    commandPanel?.setPlacement(placement);
  });

  document.getElementById('cmd-button')?.addEventListener('click', () => {
    commandPanel?.toggle();
  });
}

/**
 * Paint both halves, and tell the other tabs.
 *
 * The interface follows CSS variables on the root. The terminal is drawn on a canvas by the
 * renderer and takes its colors from xterm's own theme object, which no stylesheet can reach, so
 * every open pane is repainted directly. Setting `data-theme` alone was the entire previous
 * implementation, and nothing anywhere read it.
 *
 * Storage is also the delivery mechanism: every tab watches the key, so changing the theme in
 * one repaints all of them without a message of our own.
 */
function applyTheme(theme: string): void {
  const chosen = themeNamed(theme);
  document.documentElement.dataset['theme'] = theme;
  for (const [name, value] of Object.entries(chosen.surface)) {
    document.documentElement.style.setProperty(name, value);
  }
  /**
   * The terminal's own colors, as variables, for the things that are pictures of a terminal.
   *
   * The miniature on a session card and the box a path is typed into were painted with the dark
   * theme's colors written out by hand, so in light mode the page was mostly white with black
   * rectangles on it. They are the same two colors the renderer uses, taken from the same table,
   * so a miniature cannot disagree with the terminal it is a miniature of.
   */
  document.documentElement.style.setProperty('--term-bg', chosen.terminal.background);
  document.documentElement.style.setProperty('--term-fg', chosen.terminal.foreground);
  for (const pane of panesHost?.all ?? []) pane.controller.applyTheme(chosen.terminal);
  void chrome.storage.local.set({ 'tabterm.theme': theme });
}

/**
 * Follow the theme wherever it is changed.
 *
 * A setting changed in one tab has to reach the others: they are all the same product and a
 * preference that only applies where it was typed is not a preference. `chrome.storage` already
 * broadcasts, so watching the key costs nothing and needs no protocol.
 */
function watchTheme(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next: unknown = changes['tabterm.theme']?.newValue;
    if (typeof next !== 'string') return;
    if (document.documentElement.dataset['theme'] === next) return;
    applyTheme(next);
  });
  void chrome.storage.local.get('tabterm.theme').then((stored) => {
    applyTheme((stored['tabterm.theme'] as string | undefined) ?? DEFAULT_THEME);
  });
}

/**
 * Shortcuts Chrome owns, relayed here by the worker.
 *
 * One, now. Splitting a pane and opening the command menu were declared to Chrome as well, which
 * made them browser-wide keys listed in `chrome://extensions/shortcuts` alongside "open a
 * terminal": rows about panes, offered in every window, including windows with no terminal in
 * them. They are page shortcuts now, bound in the settings panel, which is also the only place
 * they can be changed without leaving the product. See `page-shortcuts.ts`.
 */
function installForwardedCommands(): void {
  chrome.runtime.onMessage.addListener((msg: { t?: string }) => {
    switch (msg.t ?? '') {
      default:
        return;
    }
  });
}

/**
 * What each in-page shortcut does, by id.
 *
 * Separated from the keys so that rebinding one is a change to a table of strings rather than a
 * change to the code that acts. Escape and Command Z are not in it: neither is rebindable, one
 * because leaving a mode has to be the key everything else uses for leaving a mode, and the
 * other because it is only claimed while an undo is being offered.
 */
function runPageShortcut(id: string, e: KeyboardEvent): void {
  switch (id) {
    case 'command-menu':
      commandPanel?.toggle();
      return;
    case 'split-right':
      splitFocused('horizontal');
      return;
    case 'split-down':
      splitFocused('vertical');
      return;
    case 'close-pane':
      closeFocused();
      return;
    case 'detach-pane':
      detachFocused();
      return;
    case 'launch-agent':
      // Option as well puts it beside this pane rather than in a tab of its own.
      launchAgent(e.altKey ? 'split' : 'new-tab');
      return;
    case 'clear-screen': {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      pane?.controller.clear();
      return;
    }
    case 'palette':
      palette?.open();
      return;
    default: {
      // A key bound to an action somebody made. The id carries which one. See `page-shortcuts`.
      const actionId = actionIdFrom(id);
      const action = actionId ? customActions.find((a) => a.id === actionId) : undefined;
      if (action) runCustomAction(action);
      return;
    }
  }
}

function installShortcuts(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && splitView?.maximized) {
        // Leaving focus mode must also release the keyboard lock, or Command+W stays captured
        // for the whole browser.
        if (splitView.inFocusMode) void splitView.exitFocusMode();
        else splitView.toggleMaximize(null);
        e.preventDefault();
        return;
      }
      /**
       * Command+Z is undo, for whichever of the two things is on offer.
       *
       * A clear first, because it is the shorter window and the more urgent mistake: ten seconds
       * against five minutes, and the pane it happened in is the one being looked at. Then a
       * closed or detached pane. Outside both windows the key is not ours, and it goes to the
       * shell, where Command+Z means nothing anyway.
       */
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (undoClearIfOffered() || takeUndoOffer()) {
          e.preventDefault();
          return;
        }
      }

      /**
       * Everything else comes from the table, which is what makes it rebindable.
       *
       * These used to be a switch on particular keys, so the only way to change one was to edit
       * the product, and the command menu described them from a second hand-written list that
       * had already drifted: it said Command Shift D was split down while the key was bound to
       * split right.
       */
      const pressed = describeKeys(e);
      const match = pageShortcuts.find((s) => s.keys !== '' && s.keys === pressed);
      if (!match) return;
      runPageShortcut(match.id, e);
      e.preventDefault();
    },
    { capture: true },
  );
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function statusFor(s: ConnectionStatus): void {
  lastStatus = s;
  switch (s) {
    case 'connecting':
    case 'authenticating':
      setStatus('Connecting to tabtermd', 'warn');
      return;
    case 'ready':
      setStatus('', 'hidden');
      // Anything the start screen asked about and never heard back on. A question travels on
      // this socket, so a socket that dropped took every one in flight with it.
      launcher?.connectionReady();
      askForSettings();
      return;
    case 'retrying':
      setStatus('tabtermd is not responding. Retrying', 'error');
      setFavicon('disconnected');
      return;
    case 'closed':
      setStatus('Disconnected', 'error');
      return;
  }
}

function onControl(msg: ServerMessage): void {
  /* eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check --
     Deliberately partial: unhandled messages are ignored so a newer daemon does not break an
     older page. */
  switch (msg.t) {
    case 'auth-ok': {
      if (workspaceId) client?.send({ t: 'attach-workspace', workspaceId, ...attachSize() });
      else client?.send({ t: 'create-session', ...attachSize() });
      return;
    }

    case 'session-created': {
      /**
       * A session for a different workspace usually belongs in a new tab.
       *
       * Not when the start screen is showing. That tab is empty by definition: its own shell has
       * never been used, it is displaying a list of ways to begin, and choosing one of them
       * plainly means "begin here". Opening a second tab left the chosen layout somewhere else
       * and this tab still sitting on the menu, which looked like the layout had failed.
       */
      /**
       * Asked for from this tab's start screen, so it belongs in this tab.
       *
       * The flag rather than asking whether the start screen is showing, because choosing a
       * layout dismisses it immediately and the daemon's answer arrives after that.
       */
      const wanted = layoutRequestedHere;
      layoutRequestedHere = false;
      if (!wanted && attached && workspaceId && msg.workspaceId !== workspaceId) {
        const url = chrome.runtime.getURL(`terminal.html?workspace=${msg.workspaceId}`);
        void chrome.tabs.create({ url, active: true });
        return;
      }
      workspaceId = msg.workspaceId;
      // Put the workspace in the URL so Chrome's own restore returns to this exact layout.
      const url = new URL(location.href);
      url.searchParams.set('workspace', workspaceId);
      history.replaceState(null, '', url.toString());
      client?.send({ t: 'attach-workspace', workspaceId, ...attachSize() });
      return;
    }

    case 'workspace-attached': {
      // Creating a pane element is idempotent, and a pane that already exists keeps its
      // terminal untouched. Only genuinely new panes get built.
      for (const p of msg.panes) {
        panesHost?.element(p.paneId, p.sessionId);
        panesHost?.bindStream(p.paneId, p.sessionId, p.streamId);
        // Something was launched in this pane, said by the daemon, which knows. See below.
        if (p.startedWithCommand === true) panesWithCommand.add(p.paneId);
      }
      applyLayout(msg.layout);
      attached = true;

      /**
       * A template's commands, once each pane has a prompt to receive them.
       *
       * They used to be typed the instant the panes existed, which is before any shell has
       * drawn a prompt: the text landed above the prompt rather than at it, so it was mangled
       * on screen and belonged to nothing. Pressing Return did not run it, because the shell
       * had never received it as input.
       *
       * And they are run rather than left sitting. A template is something somebody wrote down
       * to happen; typing it and waiting is the behavior of the staged-command overlay, which
       * exists for text that arrived from somewhere else and has to be read before it runs.
       */
      if (pendingTemplate) {
        const template = pendingTemplate;
        pendingTemplate = null;
        msg.panes.forEach((pane, index) => {
          const command = template.commands[index]?.trim();
          if (!command) return;
          panesHost?.whenSettled(pane.paneId, () => {
            const target = panesHost?.get(pane.paneId);
            if (target) client?.write(target.streamId, new TextEncoder().encode(`${command}\r`));
          });
        });
      }
      /**
       * A command an action asked for, once the pane it asked for exists.
       *
       * The same wait as a template's: a shell that has not drawn a prompt has nowhere to put
       * what is typed at it, and text that lands above the prompt belongs to nothing.
       */
      const waiting = takePendingCommand();
      if (waiting !== null) {
        const command = waiting;
        const newest = msg.panes[msg.panes.length - 1];
        if (newest) {
          panesHost?.whenSettled(newest.paneId, () => {
            const target = panesHost?.get(newest.paneId);
            if (target) client?.write(target.streamId, new TextEncoder().encode(`${command}\r`));
          });
        }
      }

      for (const p of msg.panes) {
        /**
         * Only a pane this page has never had a state for.
         *
         * Attaching is not a fresh start. It happens on every reload and on every reconnect,
         * and it used to set every pane back to idle, so a tab that blinked its connection while
         * an agent was waiting for somebody came back saying nothing was happening. The daemon
         * replays what it knows straight after this, which covers a genuine reload; this covers
         * the reconnect of a page that already knew.
         */
        if (paneStatus.stateOf(p.paneId) === undefined) paneStatus.set(p.paneId, 'idle');
        const state = timeStateFor(p.paneId);
        state.sessionStartedAt ??= Date.now();
      }
      setFavicon(paneStatus.effective());
      startTimeTicking();
      client?.send({ t: 'list-launcher' });
      if (splitView?.focused) panesHost?.focus(splitView.focused);
      return;
    }

    case 'workspace-updated': {
      // A layout belongs to one workspace. Applying another's would rearrange this tab into
      // somebody else's panes, which is only survivable because nothing had ever sent one.
      if (msg.workspaceId !== workspaceId) return;
      applyLayout(msg.layout);
      // A pane opened or closed is exactly when a layout may stop being the template it came
      // from, which is the one moment the title has to be worked out again.
      refreshTitle();
      return;
    }

    case 'pane-detached': {
      if (msg.workspaceId === workspaceId && !attached) {
        // This tab was restored after its session had been merged into another one. The
        // daemon handed the session back rather than calling it expired, so this tab simply
        // adopts the workspace it now lives in. See docs/04-session-lifecycle.md §7.
        workspaceId = msg.newWorkspaceId;
        const url = new URL(location.href);
        url.searchParams.set('workspace', workspaceId);
        history.replaceState(null, '', url.toString());
        client?.send({ t: 'attach-workspace', workspaceId, ...attachSize() });
        return;
      }
      /**
       * A pane left this tab on purpose, so open the tab that now owns it, **next to this one**.
       *
       * At the end of the strip it reads as an unrelated tab that happened to appear. Beside the
       * tab it came out of, it reads as the thing that just moved, which is what happened. Chrome
       * puts a tab at the end unless it is given an index.
       */
      const url = chrome.runtime.getURL(`terminal.html?workspace=${msg.newWorkspaceId}`);
      void chrome.tabs.getCurrent().then((here) => {
        void chrome.tabs.create({
          url,
          active: true,
          ...(here?.index === undefined ? {} : { index: here.index + 1 }),
        });
      });
      /**
       * And a way back, because moving a pane out is as easy to do by accident as closing one.
       *
       * It is alive in the tab it moved to, so bringing it back is an ordinary merge, which also
       * closes that tab. The offer lasts the same five minutes as the one for a closed pane:
       * there is no technical deadline here, and two different windows would be two things to
       * remember.
       */
      if (msg.sessionId) {
        offerUndo({
          sessionId: msg.sessionId,
          kind: 'detached',
          workspaceId: msg.newWorkspaceId,
          title: msg.cwd ?? '',
          at: Date.now(),
        });
      }
      client?.send({ t: 'attach-workspace', workspaceId, ...attachSize() });
      return;
    }

    case 'pane-closed': {
      /**
       * Offered only in the tab the pane was closed in.
       *
       * Every tab is told, because whether a terminal can still be brought back is a fact about
       * the session rather than about a tab, and another tab may be showing a stale offer for
       * the same one. But the offer to put it back belongs where it was.
       */
      if (msg.workspaceId === workspaceId) {
        offerUndo({ sessionId: msg.sessionId, kind: 'closed', title: msg.title, at: Date.now() });
      } else undoStack.remove(msg.sessionId);
      return;
    }

    case 'workspace-taken-over': {
      // This tab's session is alive in another tab now, so there is nothing here to show and
      // nothing to restore. Closing is the honest outcome, and it is what keeps the rule that a
      // session is never open in two places from leaving an empty tab behind.
      if (msg.workspaceId === workspaceId) {
        attached = false;
        window.close();
      }
      return;
    }

    case 'mergeable-sessions': {
      mergeable = [...msg.sessions];
      palette?.setMergeable(mergeable);
      for (const chooser of paneChoosers.values()) chooser.setSessions(mergeable);
      return;
    }

    case 'snapshot': {
      const pane = panesHost?.paneForStream(msg.snapshot.streamId);
      if (pane) {
        /**
         * At the size it was serialized at, then measured back to this pane's real size.
         *
         * Guarded, because setting the grid to the picture's width is not a request for that
         * width. Without the guard the terminal announced it, the announcement travelled the
         * same path as a measurement, and a snapshot taken at 80 by 24 became an instruction to
         * every view of that session to be 80 by 24.
         */
        followingSize.add(pane.paneId);
        /**
         * And when that has been parsed, the tab knows what it is.
         *
         * The callback rather than the next line: `write` hands bytes to the emulator and the
         * screen exists once they have been parsed. Asking a moment too early reads an empty
         * terminal and answers "nothing here", whatever the snapshot held, which put the start
         * screen over restored work.
         *
         * Decided here rather than on a timer, so a tab that is the start screen stops showing a
         * terminal it is about to cover, and one with work in it stops waiting for a clock.
         */
        panesHost?.restore(
          pane.paneId,
          msg.snapshot.screen,
          msg.snapshot.cols,
          msg.snapshot.rows,
          decideStartScreen,
        );
        followingSize.delete(pane.paneId);
        // A leftover partial-line marker above the first prompt. See `tidyPartialLine`.
        tidyPartialLine(pane.paneId);
        // Only when something came back. See `repaintAfterRestore`.
        repaintAfterRestore(pane.paneId, msg.snapshot.screen);
      }
      return;
    }

    case 'paths-resolved': {
      if (msg.cwd && msg.cwd !== currentCwd) {
        currentCwd = msg.cwd;
        pathsInFlight.clear();
      }
      for (const r of msg.results) {
        const key = cacheKey(r.candidate, msg.cwd);
        pathCache.set(key, r);
        pathsInFlight.delete(key);
      }
      panesHost?.refreshLinks();
      return;
    }

    case 'workspace-recall': {
      renderRecoveryActions(msg);
      return;
    }

    case 'launcher-state': {
      // The panel is about to be drawn, so the terminal gives up the top of the window.
      /**
       * Drawn for a new tab. For a reattach, only once we know the tab is empty.
       *
       * A reattaching tab has nothing on screen until its snapshot arrives, so asking whether
       * it is empty before then always answers yes: the start screen appeared, the snapshot
       * landed, and it was taken away again half a second later. That flash is the bug. The
       * answer is not to decide faster but to not decide until there is something to decide on.
       */
      // A tab that has already started something never draws the start screen over it, whatever
      // its panes happen to contain right now.
      if (!reattaching || startScreenDecided) openStartScreen();
      /**
       * The rest of the start screen, named before it is asked for.
       *
       * A refresh drew four different versions of the same page on the way to the right one:
       * the state, then the running list, then the restorable workspaces, then the resumable
       * agents, each replacing the last. Naming them means one drawing, when the page is known.
       */
      launcher?.expecting([
        'live',
        'resumable',
        'restorable',
        'servers',
        'templates',
        'hidden-resumes',
      ]);
      launcher?.setState(msg.state);
      launcherHome = msg.state.home;
      savedItems = [...msg.state.saved];
      palette?.setSaved(savedItems);
      commandPanel?.setFavorites(savedItems);
      // Asked for alongside launcher state, so the chips are there when the panel first draws.
      client?.send({ t: 'list-resumable', limit: 5 });
      client?.send({ t: 'list-servers' });
      askForSettings();
      client?.send({ t: 'list-live-sessions' });
      // Templates live in extension storage rather than the daemon: they are about how somebody
      // likes to start work, not about anything the daemon owns.
      void loadTemplates().then((saved) => {
        launcher?.setTemplates(saved);
        knownTemplates = saved;
        alteredTemplateCount = countToRestore(saved);
        palette?.setActions(paletteActions());
      });
      void loadActions().then((saved) => {
        customActions = saved;
        palette?.setActions(paletteActions());
      });
      client?.send({ t: 'list-restorable' });
      return;
    }

    case 'server-detected': {
      showServerOffer(msg.port);
      // The dashboard, if it is on screen, should gain the row rather than wait to be reopened.
      client?.send({ t: 'list-servers' });
      return;
    }

    case 'notify-policy': {
      notifyPolicy = msg.policy;
      commandPanel?.refreshSettings();
      return;
    }

    case 'session-size': {
      /**
       * The grid is set to what the daemon says, not to what this pane measured.
       *
       * One PTY has one size. With two views attached it is the smaller of them, and a view that
       * keeps its own larger grid is drawing into columns the shell does not know exist: lines
       * wrap somewhere else and absolute cursor moves land in the wrong column, which is a
       * full-screen application coming back as fragments of several moments overlapping.
       *
       * The pane can then be bigger than the terminal in it, which is right and is what every
       * terminal multiplexer does. Being told is the whole point: this was computed by the
       * daemon and never sent, so a view had no way to know it had been overruled.
       */
      const pane = panesHost?.forSession(msg.sessionId);
      if (!pane) return;
      /**
       * Written down before the decision, because the decision is usually to do nothing.
       *
       * A size that matches what this pane asked for is the daemon agreeing, and agreeing looks
       * exactly like never being asked. That made the repaint nudge unobservable from here: it
       * changes the size the PTY runs at and never the grid on screen, so a check that watched
       * the grid passed just as happily with the nudge removed. This is the sequence the daemon
       * actually applied, which is the thing the nudge is trying to cause.
       */
      sessionSizes.push({ paneId: pane.paneId, cols: msg.cols, rows: msg.rows });
      if (sessionSizes.length > SESSION_SIZE_MEMORY) sessionSizes.shift();
      /**
       * Followed only when it is not the size this pane asked for.
       *
       * A size arriving that matches our own request is the daemon agreeing, and there is
       * nothing to do. A size we have not asked for means we have been overruled, which happens
       * when another view of this session is smaller, and then this grid has to change or it is
       * drawing into columns the shell does not know exist.
       *
       * The distinction matters because attaching announces one size for a whole workspace,
       * before any pane has been measured. Following that back would resize every pane to the
       * window's size and then to its own, twice, while a template was typing its command into
       * one of them. It did exactly that, and the template's command was lost.
       */
      const asked = requestedSizes.get(pane.paneId);
      if (!asked) return;
      if (asked.cols === msg.cols && asked.rows === msg.rows) return;
      if (pane.controller.term.cols !== msg.cols || pane.controller.term.rows !== msg.rows) {
        /**
         * Recorded as ours before the terminal is told, not after.
         *
         * Resizing the terminal makes it announce its new size, which comes back through the
         * same path as a measurement. If the record still said what this pane last measured, the
         * announcement would look like a fresh request, the daemon would answer, and the answer
         * would look like being overruled again. That is a loop, and a loop of resizes is a
         * terminal that visibly shakes.
         */
        requestedSizes.set(pane.paneId, { cols: msg.cols, rows: msg.rows });
        /**
         * Resized without asking for it, because it was not asked for.
         *
         * Resizing the terminal makes it announce its size, which travels the same path as a
         * measurement and became a request for the size we had just been given. The daemon
         * answered, the answer looked like being overruled again, and the pane changed size
         * ninety-five times in two seconds. Being told and asking are different things and the
         * code now says so.
         */
        followingSize.add(pane.paneId);
        pane.controller.term.resize(msg.cols, msg.rows);
        followingSize.delete(pane.paneId);
      }
      return;
    }

    case 'agent-transcript': {
      launcher?.setTranscript(msg.sessionId, msg.turns);
      return;
    }

    case 'agent-command': {
      agentCommand = msg.command;
      commandPanel?.refreshSettings();
      /**
       * A tab opened by "launch an agent" runs it as soon as it knows what to run.
       *
       * Here rather than at startup because which agent is a setting the daemon owns, and this
       * message is the answer. Run through the same path a template's command uses, which waits
       * for a prompt: a command typed before the shell has drawn one lands above it and belongs
       * to nothing.
       */
      if (launchAgentOnOpen && agentCommand.trim() !== '') {
        launchAgentOnOpen = false;
        expectPane(agentCommand);
        launcher?.dismiss();
      }
      return;
    }

    case 'agent-hooks': {
      agentHooks = msg.status;
      commandPanel?.refreshSettings();
      return;
    }

    case 'folder-checked': {
      launcher?.folderChecked(msg);
      return;
    }

    case 'path-completion': {
      // One channel, two possible askers. The pane that asked last owns the answer.
      const chooser = completingPane ? paneChoosers.get(completingPane) : undefined;
      completingPane = null;
      if (chooser) chooser.setListing(msg.partial, msg.matches);
      else launcher?.pathCompletion(msg);
      return;
    }

    case 'launcher-stale': {
      /**
       * Something another tab did changed what this one is drawing.
       *
       * Only if this tab is actually showing the start screen. A tab with a terminal in it would
       * be fetching a list nobody can see, and there are usually more of those than of these.
       *
       * Asked for rather than pushed: the daemon says the answer changed and says nothing about
       * what it is, so the cost of an event is one comparison in every page and a request from
       * the few that care.
       */
      if (launcher?.isShowing !== true) return;
      /**
       * Named before they are asked for, so the screen draws once they are all back.
       *
       * Each of these answers arrives in its own message, a round trip apart, and each used to
       * redraw the whole start screen. Measured, one change elsewhere cost three redraws even
       * with a timer gathering them, because a timer cannot know how many are still coming.
       */
      /**
       * Servers too, because asking for the state asks for those as well.
       *
       * The handler for launcher state sends a second round of requests, and each answer that
       * reaches this screen redraws it. Naming them all is the difference between one drawing
       * and one per answer; naming only some leaves the rest to arrive on their own afterwards.
       */
      const alsoState = commandPanel?.isOpen !== true;
      launcher.expecting(
        alsoState ? ['live', 'resumable', 'state', 'servers'] : ['live', 'resumable'],
      );
      client?.send({ t: 'list-live-sessions' });
      client?.send({ t: 'list-resumable', limit: 8 });
      /**
       * The folder list too, unless the command menu is open.
       *
       * Launcher state carries the saved items, so asking for it also hands them to the command
       * menu, which redraws. A redraw replaces the controls in it, and a control that is
       * replaced while it is being used stops being the one that was clicked: a shortcut being
       * recorded lost the button it was recording into, and the recording simply ended.
       *
       * Nothing is lost by waiting. The menu is a thing somebody is looking at right now, and
       * the folder list is refreshed the moment it closes.
       */
      if (alsoState) client?.send({ t: 'list-launcher' });
      return;
    }

    case 'live-sessions': {
      /**
       * Everything except what this tab is already showing.
       *
       * The panes in front of you are not news, and counting them is what made the list say
       * five when four of them were elsewhere. The daemon cannot make this cut because it is
       * the same list for every tab, so the tab that knows its own panes makes it.
       */
      const mine = new Set((panesHost?.all ?? []).map((p) => p.sessionId));
      liveElsewhere = msg.sessions.filter((s) => !mine.has(s.sessionId));
      launcher?.setLiveSessions(liveElsewhere);
      // A pane offering to take one draws the same cards, so it redraws when they change.
      for (const chooser of paneChoosers.values()) chooser.render();
      // The counts, once they are known. The confirmation is already on screen by now.
      if (openPanelAt === 'reset') showResetConfirmation(msg.sessions);
      return;
    }

    case 'reset-done': {
      document.body.replaceChildren(buildResetDone(msg.sessionsEnded, msg.restarting));
      void chrome.runtime.sendMessage({ t: 'tabterm:close-other-terminals' });
      if (msg.restarting) void chrome.runtime.sendMessage({ t: 'tabterm:reload-extension' });
      return;
    }

    case 'background-timeout': {
      backgroundTimeout = msg.seconds;
      commandPanel?.refreshSettings();
      return;
    }

    case 'scrollback-budget': {
      scrollbackBytes = msg.bytes;
      commandPanel?.refreshSettings();
      return;
    }

    case 'shell-integration': {
      shellIntegration = msg.status;
      commandPanel?.refreshSettings();
      return;
    }

    case 'memory-mode': {
      memorySettings = msg;
      panesHost?.setScrollback(msg.scrollbackLines);
      // A mode that only took effect on the next tab would not help the machine it was chosen
      // for, so it is applied to what is already open.
      if (document.visibilityState === 'hidden') scheduleRendererRelease();
      return;
    }

    case 'restorable-workspaces': {
      launcher?.setRestorable(msg.workspaces);
      return;
    }

    case 'server-list': {
      launcher?.setServers(msg.servers);
      return;
    }

    case 'resumable-sessions': {
      resumableSessions = msg.sessions;
      launcher?.setResumable(msg.sessions);
      return;
    }

    case 'project-config': {
      launcher?.projectConfig(msg.cwd, msg.config);
      return;
    }

    case 'history-page': {
      palette?.setHistoryPage(msg);
      commandPanel?.setRecent(msg.entries);
      return;
    }

    case 'save-rejected': {
      // A refused hotstring has to be seen. Believing an abbreviation is set when it never
      // fires is worse than being told why it was not accepted.
      lastSaveRejection = msg.reason;
      setStatus(msg.reason, 'warn');
      setTimeout(() => setStatus('', 'hidden'), 4000);
      return;
    }

    case 'saved-updated': {
      savedItems = [...msg.saved];
      palette?.setSaved(savedItems);
      commandPanel?.setFavorites(savedItems);
      client?.send({ t: 'list-history', query: '', limit: 100 });
      return;
    }

    case 'cwd': {
      currentCwd = msg.cwd;
      titleFields = { ...titleFields, cwd: msg.cwd, ...(msg.gitRoot ? { repo: msg.gitRoot } : {}) };
      refreshTitle();
      panesHost?.refreshLinks();
      return;
    }

    case 'title': {
      titleFields = msg.fields;
      // Per session as well as for the tab, because a tab with four panes has four of these and
      // the bar on each one has to say what that pane is, not what the tab is called.
      sessionTitles.set(msg.sessionId, msg.fields);
      splitView?.refreshTitleBars();
      refreshTitle();
      return;
    }

    case 'command-start': {
      /**
       * Unless it is the redraw the clear itself asked for.
       *
       * A person who runs something after clearing does want the offer gone: an undo over new
       * output would put the old screen underneath it. The clear's own `Ctrl+L` is not that.
       */
      const cleared = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      const clearedWhen = cleared ? clearedAt.get(cleared.paneId) : undefined;
      const isAftermath =
        clearedWhen !== undefined && Date.now() - clearedWhen < CLEAR_AFTERMATH_MS;
      if (!isAftermath) dismissClearUndo();
      sessionStats.begin(msg.sessionId, msg.command, msg.startedAt);
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      if (pane) {
        const state = timeStateFor(pane.paneId);
        state.commandStartedAt = msg.startedAt;
        state.lastCommand = msg.command;
        // The title says what is running here, so it changes when that does.
        lastCommandHere = msg.command;
        refreshTitle();
        paneStatus.set(pane.paneId, 'running');
        setFavicon(paneStatus.effective());
        startTimeTicking();
      }
      return;
    }

    case 'command-end': {
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      if (pane) {
        const started = timeStateFor(pane.paneId).commandStartedAt;
        sessionStats.end(
          msg.sessionId,
          started === undefined ? 0 : msg.completedAt - started,
          msg.exitCode,
        );
      }
      if (pane) {
        const state = timeStateFor(pane.paneId);
        const startedAt = state.commandStartedAt;
        const longEnough = startedAt !== undefined && isLongRunning(startedAt);
        if (startedAt !== undefined) state.lastDurationMs = msg.completedAt - startedAt;
        else delete state.lastDurationMs;
        state.lastFinishedAt = msg.completedAt;
        if (msg.exitCode === undefined) delete state.lastExitCode;
        else state.lastExitCode = msg.exitCode;
        delete state.commandStartedAt;

        paneStatus.finished(pane.paneId, msg.exitCode);
        setFavicon(paneStatus.effective());
        // Asked for on this session, so the tab says so until somebody notices.
        if (flashing.has(msg.sessionId)) tabFlasher.start();
        /**
         * The panel is live while it is open.
         *
         * Its lists were fetched when it opened and never again, so a command run in the
         * terminal behind it did not appear until it was closed and reopened, and the stats it
         * was showing were the stats as of whenever somebody last pressed Command+K.
         */
        commandPanel?.refreshLive();
        refreshTitle();
        renderTimeLabels();

        // Only a command that ran long enough for someone to have looked away is worth a
        // status line. A fast one finished before they could miss it.
        if (longEnough) {
          const summary = describeTime({
            ...(state.lastDurationMs !== undefined ? { lastDurationMs: state.lastDurationMs } : {}),
            lastFinishedAt: msg.completedAt,
            ...(msg.exitCode !== undefined ? { lastExitCode: msg.exitCode } : {}),
          });
          setStatus(
            `${state.lastCommand ?? 'Command'} ${summary}`,
            msg.exitCode === undefined || msg.exitCode === 0 ? 'ok' : 'warn',
          );
          setTimeout(() => setStatus('', 'hidden'), 4000);
        }
      }
      return;
    }

    case 'agent-state': {
      // Structured, from the agent's own hooks. Never inferred from what is on screen.
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      if (pane) {
        const state: FaviconState =
          msg.state === 'approval'
            ? 'approval'
            : msg.state === 'waiting'
              ? 'waiting'
              : msg.state === 'working'
                ? 'running'
                : msg.state === 'failed'
                  ? 'failed'
                  : 'idle';
        paneStatus.set(pane.paneId, state);
        setFavicon(paneStatus.effective());
        titleFields = { ...titleFields, status: msg.state };
        refreshTitle();
      }
      return;
    }

    case 'process-state': {
      const pane = panesHost?.all.find((p) => p.sessionId === msg.sessionId);
      const state: FaviconState =
        msg.state === 'running'
          ? 'running'
          : msg.state === 'failed'
            ? 'failed'
            : msg.state === 'waiting' || msg.state === 'approval'
              ? msg.state
              : 'idle';
      if (pane) paneStatus.set(pane.paneId, state);
      setFavicon(paneStatus.effective());
      refreshTitle();
      return;
    }

    case 'session-exited': {
      // A pane whose process ended is removed by the daemon, which sends a new layout.
      setFavicon(msg.exitCode === 0 ? 'idle' : 'failed');
      return;
    }

    case 'error': {
      /**
       * An error about a workspace concerns the tab showing that workspace, and nobody else.
       *
       * The daemon tells every client when a workspace ends, because the tab that needs to hear
       * it is not necessarily attached at that moment. This ignored the context entirely, so
       * one workspace ending put "this terminal session expired" over every open tab, including
       * ones whose own session was alive and running.
       */
      if (msg.context !== undefined && msg.context !== '' && msg.context !== workspaceId) return;

      if (msg.code === 'session-expired' || msg.code === 'session-not-found') {
        showRecovery('This terminal session expired.');
      } else {
        setStatus(describeError(msg.code, msg.message), 'error');
      }
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Identity for this connection.
 *
 * A session tracks its attached clients by id, so two tabs sharing one id means the second
 * silently replaces the first: output stops reaching one of them and resize arbitration sees
 * one client where there are two. The profile id identifies the Chrome profile, and a
 * per-view suffix keeps each tab distinct within it.
 */
async function connectionId(): Promise<string> {
  const KEY = 'tabterm.clientId';
  const got = await chrome.storage.local.get(KEY);
  let profileId = got[KEY] as string | undefined;
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY]: profileId });
  }
  return `${profileId}:${crypto.randomUUID()}`;
}

declare global {
  interface Window {
    __tabterm?: {
      readScreen: (paneId?: string) => string;
      /** Nudge every pane to repaint, as a tab back from a long absence does. */
      redrawAfterAway: () => void;
      /** The sizes the daemon reported applying, oldest first. */
      appliedSizes: () => string[];
      /** Which pane the layout has maximized, and a way out of it. */
      /** What the tab decided it was on load, and what it decided that on. */
      startScreenReason: () => Record<string, unknown>;
      /** What prompted each drawing of the start screen, most recent last. */
      renderLog: () => readonly { at: number; since: string[] }[];
      maximizedPane: () => string | null;
      leaveFocusMode: () => void | Promise<void>;
      /** Which panes the daemon said something was launched into. */
      paneFacts: () => { paneId: string; startedWithCommand: boolean }[];
      /** Only what is on screen right now, which the strip makes a different question. */
      readViewport: (paneId?: string) => string;
      /** Draw text on a pane, for checks about what is shown rather than how it got there. */
      writeToPane: (paneId: string, text: string) => void;
      /** Send input the way a keystroke does, all the way to the shell and back. */
      sendToPane: (paneId: string, text: string) => void;
      /** How many separate writes of input this page has sent, and how many bytes. */
      inputSent: () => { writes: number; bytes: number };
      /** Which renderer each pane is drawing with, which decides how scrolling feels. */
      renderers: () => { paneId: string; webgl: boolean }[];
      /** Scroll the focused pane, the way a wheel does, for measuring how that performs. */
      scrollLines: (lines: number) => void;
      /** Rebuild the marker rail now, for measuring what that costs on a full buffer. */
      syncMarkersNow: () => void;
      /** What the daemon last said about how long a tabless terminal is kept. */
      keepAlive: () => number | null | undefined;
      /**
       * The colors on a line, which the WebGL renderer paints on a canvas nothing can query.
       *
       * One entry per run of identical color, so a check can ask whether a line came back
       * wearing what it had on rather than having to name a cell by number.
       */
      lineColors: (row: number, paneId?: string) => { text: string; fg: number }[];
      /** What is selected, which the WebGL renderer paints on a canvas nothing can query. */
      selection: () => string;
      /** What the daemon said could be resumed, before the launcher trims it for display. */
      resumable: () => { sessionId: string; cwd: string; agent: string; summary?: string }[];
      /**
       * Drop the socket without closing the tab, which is what a discarded tab, a slept
       * machine and a dead service worker all look like from the daemon.
       */
      setTheme: (name: string) => void;
      terminalTheme: () => { background?: string } | undefined;
      dropConnection: () => void;
      /** Lose the socket the way a network does, leaving the client to reconnect on its own. */
      loseConnection: () => void;
      /** Open a second, differently sized view of a pane's session, which is what a mirror is. */
      attachSecondView: (paneId: string, cols: number, rows: number) => void;
      reconnect: () => void;
      setBackgroundTimeout: (seconds: number | null) => void;
      /** Highlights on the focused pane. A decoration is painted, so the DOM cannot be asked. */
      highlights: () => { text: string; occurrence: number; color: string }[];
      /** Print a landmark, and read where the view is, without going through the menu. */
      insertMarker: (label: string, color?: string) => void;
      viewportY: () => number;
      /** Landmarks the focused pane can see. */
      markers: () => readonly { row: number; color: number }[];
      scrollToLine: (row: number) => void;
      /** Name a pane without going through its menu. */
      setPaneLabel: (paneId: string, label: string, color?: string) => void;
      /** Cell geometry, so a test can aim a real mouse event at a known character. */
      geometry: () => {
        cols: number;
        rows: number;
        left: number;
        top: number;
        cellWidth: number;
        cellHeight: number;
      } | null;
      /** End every session in this tab, so a test does not abandon them. */
      endSessions: () => void;
      workspaceId: () => string;
      paneIds: () => string[];
      /** What the tab's icon says, what the panes say, and every decision behind it. */
      faviconNow: () => {
        showing: string;
        effective: string;
        panes: { paneId: string; state: string }[];
        log: { at: number; asked: string; drew: string; why: string }[];
      };
      /** The session behind each pane, which is what an agent hook reports against. */
      paneSessions: () => { paneId: string; sessionId: string }[];
      /** Do what looking at the tab does, which is how an outcome stops being news. */
      lookAtTab: () => void;
      /** What the line under the path box knows, for when it is blank and should not be. */
      folderStateDebug: () => Record<string, unknown>;
      /** What holds the keyboard, and whether it is a thing that draws a cursor. */
      keyboardHolder: () => { what: string; typeable: boolean; paneFocused: boolean };
      /** Make the start screen redraw itself, the way a change anywhere else in TabTerm does. */
      refreshStartScreen: () => void;
      attached: () => boolean;
      split: (direction: 'horizontal' | 'vertical') => void;
      closePane: () => void;
      detachPane: () => void;
      launchAgent: (where: 'new-tab' | 'split') => void;
      saveItem: (body: string, title?: string) => void;
      /** Bytes xterm has handed us, for diagnosing an input path that looks dead. */
      inputSeen: () => number;
      /** Stream bindings and socket state, for diagnosing input that goes nowhere. */
      transport: () => string;
      /** Drive input through the same path a keystroke takes, without a synthetic key event. */
      sendInput: (paneId: string, data: string) => void;
      savedItems: () => readonly SavedItem[];
      lastSaveRejection: () => string;
      deleteSaved: (id: string) => void;
      updateSaved: (
        id: string,
        changes: { title?: string; body?: string; hotstring?: string | null },
      ) => void;
      mergeSession: (sessionId: string) => void;
      listMergeable: () => MergeableSession[];
      focus: (paneId: string) => void;
      probePaths: () => string[];
      resolvedPaths: () => ResolvedPath[];
    };
  }
}

/**
 * Testing surface.
 *
 * The WebGL renderer draws to a canvas, so terminal text is absent from the DOM and cannot be
 * read by an automated check. This exposes the buffer instead. It reveals nothing the page does
 * not already hold, and extension pages cannot be scripted from outside the extension.
 */
function installTestHook(): void {
  window.__tabterm = {
    geometry: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      const screen = pane?.element.querySelector('.xterm-screen');
      if (!pane || !screen) return null;
      const rect = screen.getBoundingClientRect();
      return {
        cols: pane.controller.term.cols,
        rows: pane.controller.term.rows,
        left: rect.left,
        top: rect.top,
        cellWidth: rect.width / pane.controller.term.cols,
        cellHeight: rect.height / pane.controller.term.rows,
      };
    },
    selection: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.term.getSelection() ?? '';
    },
    setTheme: (name) => applyTheme(name),
    terminalTheme: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.term.options.theme;
    },
    /**
     * A tab coming back after a long absence, without the absence.
     *
     * The rule for when this happens is in `wake-redraw.ts` and is checked there. This is the
     * wiring: that the nudge actually reaches a pane and that the pane ends up at the size it
     * started at rather than a row short of it. Faking the absence is the only way to check it
     * in less than a minute, and a minute is the point of the threshold.
     */
    redrawAfterAway: () => {
      for (const pane of panesHost?.all ?? []) askForRedraw(pane.paneId);
    },
    /** What the daemon said it applied, which is where a nudge is visible and the grid is not. */
    appliedSizes: () => sessionSizes.map((s) => `${s.cols}x${s.rows}`),
    /**
     * Which pane the layout has maximized, and a way out of it.
     *
     * Exposed because going full screen needs a real user gesture and a synthetic click is not
     * one, so a check cannot reach this state through the interface. What it is checking is the
     * layout, which is here.
     */
    /** What the tab decided it was on load, and what it decided that on. */
    startScreenReason: () => startScreenReason,
    /** What prompted each drawing of the start screen, most recent last. */
    renderLog: () => launcher?.renderLog() ?? [],
    maximizedPane: () => splitView?.maximized ?? null,
    leaveFocusMode: () => splitView?.exitFocusMode(),
    /** Which panes the daemon said something was launched into. */
    paneFacts: () =>
      (panesHost?.all ?? []).map((p) => ({
        paneId: p.paneId,
        startedWithCommand: panesWithCommand.has(p.paneId),
      })),
    /**
     * A second view of one session, at a size of its choosing.
     *
     * Two views is a supported thing to have, and it is where the size the terminal runs at
     * stops being the size any one view asked for. Reproducing that needs a second connection
     * rather than a second tab, because the point is what this page does when it is overruled.
     */
    attachSecondView: (paneId, cols, rows) => {
      // By pane, because the ids this hook reports elsewhere are shortened for reading and a
      // shortened session id attaches to nothing at all.
      const sessionId = panesHost?.get(paneId)?.sessionId;
      if (!sessionId) return;
      void (async () => {
        const mirror = new DaemonClient({
          port: connectedPort,
          token: (await getToken()) ?? '',
          clientId: `${await connectionId()}:mirror`,
          role: 'data',
          onControl: () => {},
          onOutput: () => {},
          onStatus: () => {},
        });
        mirror.connect();
        setTimeout(() => mirror.send({ t: 'attach', sessionId, cols, rows }), 400);
      })();
    },
    reconnect: () => client?.connect(),
    setBackgroundTimeout: (seconds) => client?.send({ t: 'set-background-timeout', seconds }),
    resumable: () =>
      resumableSessions.map((r) => ({
        sessionId: r.sessionId,
        cwd: r.cwd,
        agent: r.agent,
        ...(r.summary === undefined ? {} : { summary: r.summary }),
      })),
    highlights: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return [...(pane?.controller.highlights ?? [])];
    },
    insertMarker: (label, color) => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      if (!pane) return;
      // The same rule as the menu entry: printing into a screen a program owns corrupts it.
      if (panesWithCommand.has(pane.paneId)) return;
      client?.send({
        t: 'insert-marker',
        sessionId: pane.sessionId,
        label,
        ...(color === undefined ? {} : { color }),
        cols: pane.controller.term.cols,
      });
    },
    markers: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.markers ?? [];
    },
    scrollToLine: (row) => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      pane?.controller.term.scrollToLine(row);
    },
    viewportY: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : undefined;
      return pane?.controller.term.buffer.active.viewportY ?? -1;
    },
    setPaneLabel: (paneId, label, color) => {
      if (!workspaceId) return;
      client?.send({
        t: 'set-pane-label',
        workspaceId,
        paneId,
        label,
        ...(color === undefined ? {} : { color }),
      });
    },
    /**
     * End every session in this tab. For tests, which would otherwise abandon them.
     *
     * Sessions survive a daemon restart now, so a test run that opened twenty terminals and walked
     * away left twenty shells running forever. Measured: 468 abandoned sessions after a week.
     */
    endSessions: () => {
      for (const pane of panesHost?.all ?? []) {
        if (pane.sessionId) client?.send({ t: 'kill-session', sessionId: pane.sessionId });
      }
    },
    keepAlive: () => backgroundTimeout,
    lineColors: (row, paneId) => {
      const target = paneId ?? splitView?.focused ?? panesHost?.all[0]?.paneId;
      const pane = target ? panesHost?.get(target) : undefined;
      const line = pane?.controller.term.buffer.active.getLine(row);
      if (!line) return [];
      const runs: { text: string; fg: number }[] = [];
      // Reused across the row, which is how xterm intends a buffer to be walked: allocating a
      // cell per column on a wide terminal is thousands of objects for one answer.
      const cell = line.getCell(0);
      if (!cell) return [];
      for (let x = 0; x < line.length; x++) {
        if (!line.getCell(x, cell)) continue;
        const chars = cell.getChars();
        if (chars === '') continue;
        const fg = cell.isFgDefault() ? -1 : cell.getFgColor();
        const last = runs[runs.length - 1];
        if (last && last.fg === fg) last.text += chars;
        else runs.push({ text: chars, fg });
      }
      return runs;
    },
    /**
     * Only the rows actually on screen, which is a different question from what is in the buffer.
     *
     * The start screen leaves the terminal two rows tall, and "the prompt is missing" has always
     * meant it was out of view rather than gone. Reading the whole buffer cannot tell those
     * apart, which is why the defect survived being checked twice.
     */
    /**
     * Put text on a pane's screen without a shell producing it.
     *
     * For checks about what is on screen rather than about how it got there. The lone `%` a
     * shell prints for a partial line is the case this exists for: reproducing it through a real
     * command means depending on a particular shell's configuration, which is a test about zsh
     * rather than about TabTerm.
     */
    writeToPane: (paneId, text) => {
      const target = paneId || splitView?.focused || panesHost?.all[0]?.paneId;
      const pane = target ? panesHost?.get(target) : undefined;
      pane?.controller.write(new TextEncoder().encode(text), () => {});
    },
    /**
     * Send input the way a keystroke does, all the way to the shell.
     *
     * `writeToPane` draws into the emulator here and never leaves the page, which is right for
     * checking how something renders and useless for measuring how long anything takes. This is
     * the other half: the same call a typed character makes, so what comes back has been through
     * the host, the daemon and the socket.
     */
    inputSent: () => ({ ...(client?.sent ?? { writes: 0, bytes: 0 }) }),
    syncMarkersNow: () => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : panesHost?.all[0];
      pane?.controller.syncMarkersForTest();
    },
    scrollLines: (lines) => {
      const pane = splitView?.focused ? panesHost?.get(splitView.focused) : panesHost?.all[0];
      pane?.controller.term.scrollLines(lines);
    },
    renderers: () =>
      (panesHost?.all ?? []).map((p) => ({
        paneId: p.paneId,
        webgl: p.controller.rendererAttached,
      })),
    sendToPane: (paneId, text) => {
      const target = paneId || splitView?.focused || panesHost?.all[0]?.paneId;
      const pane = target ? panesHost?.get(target) : undefined;
      if (pane) client?.write(pane.streamId, new TextEncoder().encode(text));
    },
    readViewport: (paneId) => {
      const target = paneId ?? splitView?.focused ?? panesHost?.all[0]?.paneId;
      const pane = target ? panesHost?.get(target) : undefined;
      if (!pane) return '';
      const term = pane.controller.term;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    readScreen: (paneId) => {
      const target = paneId ?? splitView?.focused ?? panesHost?.all[0]?.paneId;
      const pane = target ? panesHost?.get(target) : undefined;
      if (!pane) return '';
      const buf = pane.controller.term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    },
    workspaceId: () => workspaceId,
    paneIds: () => (layout ? collectPanes(layout) : []),
    faviconNow: () => ({
      showing: faviconState,
      effective: paneStatus.effective(),
      panes: (layout ? collectPanes(layout) : []).map((paneId) => ({
        paneId,
        state: paneStatus.stateOf(paneId) ?? 'none',
      })),
      log: [...faviconLog],
    }),
    paneSessions: () =>
      (panesHost?.all ?? []).map((p) => ({ paneId: p.paneId, sessionId: p.sessionId })),
    lookAtTab: () => lookedAtTab(),
    folderStateDebug: () => launcher?.folderStateDebug() ?? {},
    keyboardHolder: () => {
      const active = document.activeElement;
      const what =
        active === null
          ? 'nothing'
          : active === document.body
            ? 'body'
            : active.className !== ''
              ? active.className
              : active.tagName;
      return {
        what,
        // A terminal draws a solid cursor only while its own textarea holds the keyboard.
        typeable: isTypingField(active) || what.includes('xterm-helper-textarea'),
        paneFocused: (splitView?.focused ?? '') !== '',
      };
    },
    refreshStartScreen: () => client?.send({ t: 'list-launcher' }),
    dropConnection: () => client?.close(),
    loseConnection: () => client?.dropForTest(),
    attached: () => attached,
    split: (direction) => splitFocused(direction),
    closePane: () => closeFocused(),
    detachPane: () => detachFocused(),
    mergeSession: (sessionId) => {
      const targetPaneId = splitView?.focused;
      if (!targetPaneId || !workspaceId) return;
      client?.send({
        t: 'merge-into',
        workspaceId,
        targetPaneId,
        sessionId,
        direction: 'horizontal',
      });
    },
    launchAgent: (where) => launchAgent(where),
    inputSeen: () => inputBytesSeen,
    transport: () =>
      JSON.stringify({
        panes: (panesHost?.all ?? []).map((p) => ({
          paneId: p.paneId.slice(0, 8),
          sessionId: p.sessionId.slice(0, 8),
          streamId: p.streamId,
        })),
        status: lastStatus,
        port: connectedPort,
      }),
    sendInput: (paneId, data) => {
      const pane = panesHost?.get(paneId);
      if (pane) client?.write(pane.streamId, new TextEncoder().encode(data));
    },
    savedItems: () => savedItems,
    lastSaveRejection: () => lastSaveRejection,
    deleteSaved: (id) => client?.send({ t: 'delete-saved', id }),
    updateSaved: (id, changes) => client?.send({ t: 'update-saved', id, ...changes }),
    saveItem: (body, title) => {
      client?.send({ t: 'save-item', title: title ?? body.slice(0, 60), body });
    },
    listMergeable: () => {
      if (workspaceId) client?.send({ t: 'list-mergeable', workspaceId });
      return mergeable;
    },
    focus: (paneId) => splitView?.focus(paneId),
    probePaths: () => {
      const screen = window.__tabterm?.readScreen() ?? '';
      const found = [
        ...new Set(screen.split('\n').flatMap((l) => findCandidates(l).map((c) => c.text))),
      ];
      const pane = panesHost?.get(splitView?.focused ?? '');
      const unknown = found.filter(
        (x) => !pathCache.has(cacheKey(x)) && !pathsInFlight.has(cacheKey(x)),
      );
      if (unknown.length > 0 && pane) {
        for (const x of unknown) pathsInFlight.add(cacheKey(x));
        client?.send({ t: 'resolve-paths', sessionId: pane.sessionId, candidates: unknown });
      }
      return found;
    },
    resolvedPaths: () => [...pathCache.values()],
  };
}

async function start(): Promise<void> {
  const token = await getToken();
  if (!token) {
    showRecovery('TabTerm is not paired with the daemon yet.');
    return;
  }

  // Read once, so the first right-click already shows the color that was last used.
  refreshRecentColors();
  refreshFlashing();
  loadHiddenResumes();
  // Before anything is drawn, so a tab never flashes the wrong theme on the way in.
  watchTheme();
  buildHosts();
  buildLauncher();
  buildCommandPanel();
  installTestHook();
  installModifierTracking();
  /**
   * Not awaited, because everything after it in this function is the terminal appearing.
   *
   * Awaiting a storage read here delayed the panel, the palette and the panes behind it, which
   * showed up as a command menu that was sometimes empty depending on how busy the machine was.
   * The listener reads this table at the moment a key is pressed, so it starts with the shipped
   * bindings and picks up stored ones as soon as they arrive, which is well before anybody has
   * pressed anything.
   */
  pageShortcuts = [...DEFAULT_PAGE_SHORTCUTS];
  void refreshShortcuts();
  watchSharedSettings();
  installShortcuts();
  installForwardedCommands();
  // Asked once at startup, so the palette's hints describe the keys Chrome really has.
  refreshBoundShortcuts();
  installAmbientFocus();
  installPageMenu();
  installRefitOnWake();
  // A reattached session gets the whole window from the start. Nothing about it is new, so
  // there is nothing to offer.
  /**
   * A reattach keeps its terminal, **unless the terminal has nothing in it**.
   *
   * The URL gains a workspace as soon as a session is created, so refreshing a tab that was
   * still showing the start screen looked exactly like reattaching to real work and dropped the
   * person into a bare shell in their home directory. A tab showing an untouched shell has not
   * begun, whatever its URL says, so the decision is made from the screen rather than the URL.
   *
   * Deferred until the snapshot has been applied, because until then every pane is empty and
   * the question cannot be answered.
   */
  if (reattaching) {
    /**
     * Nothing is shown until the answer is known, and the answer is known when the snapshot has
     * been applied rather than when a timer says so.
     *
     * Both wrong answers were reported. A tab with work in it flashed the start screen, which was
     * fixed by holding the start screen back; a tab that **is** the start screen then paid the
     * same wait in the other direction, showing its terminal for most of a second and then being
     * covered over. Waiting is fine. Showing the wrong thing while waiting is not.
     *
     * The panes are hidden rather than removed, because a pane with no box cannot be measured,
     * and a size nobody measured is the other thing that goes wrong on a tab that has just
     * opened. `visibility` keeps the box and takes away only the picture.
     *
     * The timer stays as a ceiling. A snapshot that never arrives must not leave a tab showing
     * nothing at all.
     */
    root.classList.add('deciding');
    /**
     * The ceiling, which waits for there to be something to decide about.
     *
     * Nine hundred milliseconds is generous on an idle machine and short on a loaded one, and
     * when it fired before any pane existed the tab decided what to show on no evidence at all.
     * Nothing is on screen either way while this waits, so waiting costs nothing and deciding
     * early costs the answer.
     *
     * It still has an end. A snapshot that never arrives must not leave a tab showing nothing.
     */
    const decideWhenThereIsSomething = (waited: number): void => {
      if ((panesHost?.all.length ?? 0) > 0 || waited >= 4000) {
        decideStartScreen();
        return;
      }
      setTimeout(() => {
        decideWhenThereIsSomething(waited + 300);
      }, 300);
    };
    setTimeout(() => {
      decideWhenThereIsSomething(900);
    }, 900);
  }
  // Leaving fullscreen by any route, including the Escape the browser handles itself, must
  // put the layout back and release the lock.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && splitView?.maximized) void splitView.exitFocusMode();
  });
  setFavicon('disconnected');
  refreshTitle();

  /**
   * Opened by "launch an agent", from the toolbar icon or the browser shortcut.
   *
   * Only a flag here. What to run is a setting the daemon owns, so this waits for the answer
   * rather than guessing at `claude`, and a tab that never hears back shows its start screen,
   * which is the right thing for a tab with nothing in it.
   */
  launchAgentOnOpen = params.get('agent') === '1';
  if (launchAgentOnOpen) {
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete('agent');
    history.replaceState(null, '', cleaned.toString());
  }

  // A command handed over by a context menu. It is only ever displayed here; nothing sends it
  // anywhere until the user says so.
  const staged = params.get('staged');
  if (staged) showStaged(staged, params.get('stagedFrom') ?? 'a webpage');

  /**
   * A command this tab was opened to run, by an action that asked for a new tab.
   *
   * Run rather than staged, because it is an action somebody made and chose: the staging overlay
   * is for text that arrived from somewhere else. The command is not in the URL, it is behind a
   * one-shot key in session storage, so a link cannot carry one. Read once and removed, and it
   * waits for a prompt for the same reason a template's commands do.
   */
  const ticket = params.get('ticket');
  if (ticket) {
    const url = new URL(location.href);
    url.searchParams.delete('ticket');
    history.replaceState(null, '', url.toString());
    try {
      const held = (await chrome.storage.session.get(ticket)) as Record<string, unknown>;
      const command: unknown = held[ticket];
      await chrome.storage.session.remove(ticket);
      if (typeof command === 'string' && command !== '') expectPane(command);
    } catch {
      // No session storage is no command, which is the safe direction.
    }
  }

  connectedPort = await daemonPort();
  client = new DaemonClient({
    port: connectedPort,
    token,
    clientId: await connectionId(),
    role: 'data',
    onControl,
    onOutput: (streamId, data) => {
      panesHost?.write(streamId, data, (bytes) => client?.ack(streamId, bytes));
      // Output after a clear is the shell's redraw arriving, which is the clear finishing.
      if (clearSettling.size > 0) {
        const pane = panesHost?.paneForStream(streamId);
        if (pane) clearSettling.delete(pane.paneId);
      }
      growStripToFit();
      /**
       * A pane that has started printing is a pane in use, so any offer over it goes.
       *
       * Coalesced, because this runs on every chunk and the answer only changes once. Deferred
       * as well, since xterm parses what it is given on its own schedule and asking immediately
       * asks about the screen as it was before this chunk.
       */
      if (paneChoosers.size > 0) {
        clearTimeout(chooserRecheckTimer);
        chooserRecheckTimer = setTimeout(syncPaneChoosers, 120);
      }
    },
    onStatus: statusFor,
    onAuthRefused: () => {
      /**
       * The token this page holds has been refused, so it is dropped and fetched again.
       *
       * Retrying with a rejected token forever is what a page did before this: it reconnected on
       * schedule, offered the same one every time, and showed "not responding" until the tab was
       * closed. A token can genuinely change under a running page, when a daemon is reinstalled
       * or its state directory is cleared.
       */
      void (async () => {
        await chrome.storage.session.remove('tabterm.token');
        const fresh = await getToken();
        if (fresh) client?.setToken(fresh);
      })();
      setStatus('Reconnecting to tabtermd', 'warn');
    },
    onProtocolError: (detail) => {
      // Said out loud rather than logged. A tab that quietly stops updating is the worst
      // possible failure, because nothing distinguishes it from a session with nothing to say.
      setStatus(`TabTerm hit a problem: ${detail}`, 'error');
    },
  });
  client.connect();

  /**
   * The tab is being looked at.
   *
   * Its own function so a check can call it. A synthetic `visibilitychange` is not a substitute:
   * `document.visibilityState` is read inside, and it is whatever the browser says regardless of
   * what event was dispatched, so a faked one exercises the hidden branch and reports that the
   * visible one works.
   */
  lookedAtTab = (): void => {
    clearTimeout(rendererTimer);
    rendererTimer = undefined;
    panesHost?.restoreRenderers();
    if (splitView?.focused) panesHost?.focus(splitView.focused);
    /**
     * Looking at the tab is what clears an outcome.
     *
     * A tick that said a command finished has now done its job, and it goes back to idle so
     * the next one still means something. On a timer instead it would expire while nobody
     * was there to read it, which is the exact case it exists for.
     */
    if (paneStatus.seen()) refreshTitle();
    setFavicon(paneStatus.effective());
    startTimeTicking();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lookedAtTab();
    } else {
      clearInterval(animTimer);
      animTimer = undefined;
      // Leave the icon on a full, steady frame rather than wherever the pulse happened to stop,
      // so a hidden tab reads as a state rather than as a moment.
      if (needsAttention(faviconState) && memorySettings.faviconWhileHidden) {
        applyFavicon(drawFavicon(faviconState, 3));
      }
      // A hidden tab throttles timers anyway, and nobody is reading the label.
      stopTimeTicking();
      scheduleRendererRelease();
    }
  });
}

/**
 * The reset confirmation draws before anything is connected.
 *
 * Waiting for the daemon to report its sessions first meant a blank page whenever the daemon was
 * unreachable, which is precisely the situation somebody reaches for a reset in. It draws now
 * with what it knows, and fills in the counts if they arrive.
 */
if (openPanelAt === 'reset') showResetConfirmation([]);

// Lazy attach: do nothing until the tab is actually looked at.
if (document.visibilityState === 'visible') {
  void start();
} else {
  setStatus('Suspended. Activate this tab to reconnect.', 'warn');
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'visible') void start();
    },
    { once: true },
  );
}
