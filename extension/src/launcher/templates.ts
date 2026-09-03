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
