/**
 * Command Shift G in a folder box opens the macOS Choose a Folder window at the folder typed, the
 * key that opens Go to Folder in every macOS file window. Asked for in those words, for every box
 * that takes a folder: the start screen's, and an empty pane's in a split or the side panel.
 */
export function isChooseFolderKey(e: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'g';
}
