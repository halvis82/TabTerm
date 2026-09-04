/**
 * Layout templates: a folder, an arrangement, and a command per pane.
 *
 * The thing people actually repeat is not "three panes" but "three panes in this project, with
 * the agent in one and a build watching in another". A template is that, saved by name.
 *
 * Commands **run**, once each pane has drawn a prompt. Staging them was the original design, on
 * the reasoning that a saved thing which executes on click is how somebody deploys by
 * mis-clicking a menu. That reasoning belongs to text which arrived from somewhere else, which
 * is what the staged-command overlay is for. A template is something you wrote down to happen,
 * and one that types `claude` and then waits has not done the thing it is named after.
 */

import type { LayoutShape } from '@tabterm/shared';

export interface LayoutTemplate {
  id: string;
  name: string;
  path: string;
  shape: LayoutShape;
  panes: number;
  /** One per pane, in pane order. An empty string leaves that pane at a bare prompt. */
  commands: string[];
  /**
   * The shape as it was written, such as `(1+2)/3`.
   *
   * Kept alongside the old fixed shapes rather than replacing them, so templates saved before
   * this existed still open. When it is here it is what decides the layout, and the numbers in
   * it name the sessions: the same number twice is the same session in two places.
   */
  layout?: string;
  /** Keyed by the session numbers used in `layout`. */
  sessionCommands?: Record<string, string>;
  /** Optional, for when the name is not enough to remember what this was for. */
  description?: string;
}

const KEY = 'tabterm.templates';
/** Set once the defaults have been offered, so deleting one does not bring it back. */
const SEEDED = 'tabterm.templatesSeeded';

/**
 * The templates everybody starts with.
 *
 * Built exactly as a hand-written one is, rather than as a special case: a shape of `1`, which
 * is one session, and that session's command. There used to be an `Open agent here` button
 * beside the layouts that did something no template could express, which meant the one thing
 * most people wanted was the one thing they could not edit, copy or reorder.
 *
 * Ordinary templates now. Rename them, change what they run, give them two panes, or delete
 * them.
 */
export const DEFAULT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'default-split-2',
    name: 'Split in 2',
    path: '~',
    shape: 'columns',
    panes: 2,
    layout: '1+2',
    commands: ['', ''],
    sessionCommands: { '1': '', '2': '' },
    description: 'Two terminals side by side.',
  },
  {
    id: 'default-one-plus-two',
    name: '1 + 2',
    path: '~',
    shape: 'one-plus-two',
    panes: 3,
    layout: '1+(2/3)',
    commands: ['', '', ''],
    sessionCommands: { '1': '', '2': '', '3': '' },
    description: 'One on the left, two stacked on the right.',
  },
  {
    id: 'default-quad',
    name: '4 panes',
    path: '~',
    shape: 'quad',
    panes: 4,
    layout: '(1+2)/(3+4)',
    commands: ['', '', '', ''],
    sessionCommands: { '1': '', '2': '', '3': '', '4': '' },
    description: 'One in each corner.',
  },
  {
    id: 'default-claude',
    name: 'claude',
    path: '~',
    shape: 'single',
    panes: 1,
    layout: '1',
    commands: ['claude'],
    sessionCommands: { '1': 'claude' },
    description: 'One terminal running Claude Code in the folder above.',
  },
  {
    id: 'default-codex',
    name: 'codex',
    path: '~',
    shape: 'single',
    panes: 1,
    layout: '1',
    commands: ['codex'],
    sessionCommands: { '1': 'codex' },
    description: 'One terminal running Codex in the folder above.',
  },
];

/**
 * Which defaults are missing or have been changed.
 *
 * Used to decide whether to offer restoring them at all: an option that is always there for
 * something you have not done is one more thing to read past every time you open settings.
 */
export function alteredDefaults(current: readonly LayoutTemplate[]): LayoutTemplate[] {
  const byId = new Map(current.map((t) => [t.id, t]));
  return DEFAULT_TEMPLATES.filter((original) => {
    const mine = byId.get(original.id);
    return mine === undefined || JSON.stringify(mine) !== JSON.stringify(original);
  });
}

/**
 * Put back what is missing, in the order it originally had, and touch nothing else.
 *
 * A default you edited is left alone unless it is gone: restoring is for getting back what you
 * removed, and silently reverting something you deliberately changed would be the same button
 * doing two different jobs.
 */
export function withDefaultsRestored(current: readonly LayoutTemplate[]): LayoutTemplate[] {
  const have = new Set(current.map((t) => t.id));
  const missing = DEFAULT_TEMPLATES.filter((t) => !have.has(t.id));
  if (missing.length === 0) return [...current];
  // The originals lead, in their own order, then everything else keeps the order it had.
  const restoredIds = new Set(missing.map((t) => t.id));
  const rest = current.filter((t) => !restoredIds.has(t.id));
  const front = DEFAULT_TEMPLATES.filter((t) => restoredIds.has(t.id) || have.has(t.id)).flatMap(
    (t) => (restoredIds.has(t.id) ? [t] : []),
  );
  return [...front, ...rest];
}
/** How many panes each shape produces, so a template knows how many commands it needs. */
export function panesFor(shape: LayoutShape): number {
  switch (shape) {
    case 'single':
      return 1;
    case 'columns':
      return 2;
    case 'one-plus-two':
      return 3;
    case 'quad':
      return 4;
    case 'rows':
      return 2;
    default:
      return 1;
  }
}

/** Anything unreadable is treated as absent: a bad entry must not cost the whole list. */
export function parseTemplates(raw: unknown): LayoutTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: LayoutTemplate[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Partial<LayoutTemplate>;
    if (typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.path !== 'string') {
      continue;
    }
    out.push({
      id: t.id,
      name: t.name,
      path: t.path,
      shape: t.shape ?? 'single',
      panes: typeof t.panes === 'number' ? t.panes : panesFor(t.shape ?? 'single'),
      commands: Array.isArray(t.commands) ? t.commands.map((c) => String(c)) : [],
      // Present only when it was written down, so a template from before this existed keeps
      // opening exactly as it did.
      ...(typeof t.layout === 'string' && t.layout !== '' ? { layout: t.layout } : {}),
      ...(typeof t.description === 'string' && t.description !== ''
        ? { description: t.description }
        : {}),
      ...(t.sessionCommands && typeof t.sessionCommands === 'object'
        ? {
            sessionCommands: Object.fromEntries(
              Object.entries(t.sessionCommands).map(([k, v]) => [k, String(v)]),
            ),
          }
        : {}),
    });
  }
  return out;
}

export async function loadTemplates(): Promise<LayoutTemplate[]> {
  try {
    const stored = await chrome.storage.local.get([KEY, SEEDED]);
    const saved = parseTemplates(stored[KEY]);
    /**
     * The defaults are offered once, not merged in forever.
     *
     * Merging on every load would mean a default you deleted came back the next time the start
     * screen drew, which is the behavior of a thing that will not listen. A flag records that
     * they have been offered, so after that the list is entirely yours.
     */
    if (stored[SEEDED] === true) return saved;
    const seeded = [...DEFAULT_TEMPLATES, ...saved];
    await chrome.storage.local.set({ [KEY]: seeded, [SEEDED]: true });
    return seeded;
  } catch {
    return [];
  }
}

export async function saveTemplates(templates: readonly LayoutTemplate[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: templates });
  } catch {
    // A template that could not be saved is worth less than the terminal still working.
  }
}
