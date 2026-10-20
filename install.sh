#!/bin/zsh
# Builds the SF Symbol glyphs on this Mac and installs the plugin into Cider.
set -euo pipefail
cd "${0:A:h}"
command -v swiftc >/dev/null || { echo "swiftc not found: install the Xcode command line tools (xcode-select --install)"; exit 1; }
python3 tools/build.py
DEST="$HOME/Library/Application Support/sh.cider.genten/plugins/native"
mkdir -p "$DEST"
cp plugin.yml *.js "$DEST/"
echo "Installed to $DEST"
echo "Next: in Cider open Settings > Extensions, enable \"Native\", then quit and reopen Cider."
