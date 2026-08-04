# ADR-0014 — Cut drag-from-Finder path insertion

**Status:** Accepted

## Context
A natural feature request is dragging a file from Finder into a terminal to paste its
escaped path, open it in vim, or cd into a folder. In a Chrome page this is not possible: HTML5
drag-and-drop yields a `File` object with a **name only**. `File.path` is an Electron extension, not
web. `webkitGetAsEntry()` gives paths relative to a dropped directory root, never absolute. The File
System Access API gives opaque handles, not paths.

## Decision
Cut the feature. Do not implement a workaround.

## Consequences
- The feature is removed from scope entirely, recorded in `10-limitations.md` tier 0.5.
- The valuable adjacent behavior is unaffected and is implemented instead: paths **printed by a
  command** are clickable and Option-clickable, the path detection work and the editor-open work.
- `Cmd+Opt+C` in Finder already copies a path as text for a normal paste, with zero code from us.

## Alternatives rejected
- **Hash the dropped file's contents and locate it via Spotlight.** Works, ambiguous when duplicates
  exist, heavy, and solves a problem nobody asked for.
- **Ship a native helper to read the drag pasteboard.** Disproportionate for a rarely used gesture.
