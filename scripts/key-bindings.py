#!/usr/bin/env python3
"""Silence the beep on Control Command Left, Right and Down. See docs/10-limitations.md tier 1.9.

macOS binds those three keys to changing text writing direction, which Chrome does not implement,
so AppKit beeps on every press before the page sees the key. Binding them to `noop:` in the
person's own key bindings file ends that, in every application, once Chrome has been restarted.

    key-bindings.py status   [file]   prints "in place", "missing" or "taken"
    key-bindings.py install  [file]   adds the three bindings, keeping everything already there

The file is the person's, so nothing in it is replaced. A key they bound to something else is left
alone and reported as taken. A file that exists is copied aside before it is written, and written
back as XML, because that is the format Python can write and AppKit reads any format.
"""

import os
import plistlib
import shutil
import subprocess
import sys

DEFAULT = os.path.expanduser('~/Library/KeyBindings/DefaultKeyBinding.dict')
# Control Command Left, Right and Down: `@` is Command, `^` is Control.
KEYS = ['@^', '@^', '@^']
NOOP = 'noop:'
# Written when there is no file yet, in the form people find in guides and can read.
FRESH = '{\n    "@^\\UF702" = "noop:";\n    "@^\\UF703" = "noop:";\n    "@^\\UF701" = "noop:";\n}\n'


def read(path):
    """The bindings in the file, whatever plist format it is in. Old-style needs plutil."""
    if not os.path.exists(path):
        return None
    xml = subprocess.run(
        ['plutil', '-convert', 'xml1', '-o', '-', path], capture_output=True, check=True
    ).stdout
    return plistlib.loads(xml)


def status(bindings):
    if bindings is None:
        return 'missing'
    if all(bindings.get(k) == NOOP for k in KEYS):
        return 'in place'
    if any(k in bindings and bindings[k] != NOOP for k in KEYS):
        return 'taken'
    return 'missing'


def install(path):
    bindings = read(path)
    if bindings is None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(FRESH)
        return 'added'
    added = [k for k in KEYS if k not in bindings]
    if not added:
        return status(bindings)
    shutil.copy2(path, path + '.before-tabterm')
    for k in added:
        bindings[k] = NOOP
    with open(path, 'wb') as f:
        plistlib.dump(bindings, f)
    return 'added' if status(bindings) == 'in place' else 'added, and left keys bound to something else'


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('status', 'install'):
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT
    print(status(read(path)) if sys.argv[1] == 'status' else install(path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
