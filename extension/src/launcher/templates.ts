/**
 * Layout templates: a folder, an arrangement, and a command per pane.
 *
 * The thing people actually repeat is not "three panes" but "three panes in this project, with
 * the agent in one and a build watching in another". A template is that, saved by name.
 *
 * Commands are **staged, not run**: they are typed into each pane and left at the prompt. Every
 * other surface in this product works that way, and a saved thing that executes on click is how
 * somebody ends up running a deploy because they mis-clicked a menu.
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
}

const KEY = 'tabterm.templates';

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
    });
  }
  return out;
}

export async function loadTemplates(): Promise<LayoutTemplate[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return parseTemplates(stored[KEY]);
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
