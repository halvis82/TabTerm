/**
 * Actions somebody made, beside the ones that ship.
 *
 * `Launch an agent in a new tab` used to be a built-in that ran whatever agent was configured,
 * which meant the one thing most people want to change was the one thing they could not. The
 * answer is the same as it was for templates: make it an ordinary object, and let the built-ins
 * be examples of it rather than a separate species.
 *
 * Two kinds, because they are the two things an action can usefully do that a template cannot
 * already express on the start screen: open a template from wherever you are, or run a command
 * in a new terminal. A third kind would need a reason.
 */

import type { LayoutTemplate } from './templates.js';

export interface CustomAction {
  id: string;
  name: string;
  description?: string;
  /** Which template to open. Present when `kind` is `template`. */
  templateId?: string;
  /** What to run. Present when `kind` is `command`. */
  command?: string;
  kind: 'template' | 'command';
  /** Where a command lands. A template brings its own arrangement and ignores this. */
  where: 'new-tab' | 'split';
}

const KEY = 'tabterm.actions';

/** Anything unreadable is treated as absent: one bad entry must not cost the whole list. */
export function parseActions(raw: unknown): CustomAction[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomAction[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as Partial<CustomAction>;
    if (typeof a.id !== 'string' || typeof a.name !== 'string') continue;
    if (a.kind !== 'template' && a.kind !== 'command') continue;
    if (a.kind === 'template' && typeof a.templateId !== 'string') continue;
    if (a.kind === 'command' && typeof a.command !== 'string') continue;
    out.push({
      id: a.id,
      name: a.name,
      kind: a.kind,
      where: a.where === 'split' ? 'split' : 'new-tab',
      ...(a.description === undefined ? {} : { description: a.description }),
      ...(a.templateId === undefined ? {} : { templateId: a.templateId }),
      ...(a.command === undefined ? {} : { command: a.command }),
    });
  }
  return out;
}

export async function loadActions(): Promise<CustomAction[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return parseActions(stored[KEY]);
  } catch {
    return [];
  }
}

export async function saveActions(actions: readonly CustomAction[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: actions });
  } catch {
    // An action that could not be saved is worth less than the terminal still working.
  }
}

/**
 * What a row should say it does, in the words somebody would use for it.
 *
 * The name is theirs and may be anything, so this is the line underneath: what will actually
 * happen when it is chosen. A description they wrote wins, because they know why they made it.
 */
export function describeAction(action: CustomAction, templates: readonly LayoutTemplate[]): string {
  if (action.description) return action.description;
  if (action.kind === 'template') {
    const template = templates.find((t) => t.id === action.templateId);
    return template ? `Opens the ${template.name} template here` : 'Opens a template that is gone';
  }
  const where = action.where === 'split' ? 'beside this pane' : 'in a new tab';
  return `Runs ${action.command ?? ''} ${where}`;
}
