#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "OLKIL CLI needs Node.js 18+."
  echo "Install it from https://nodejs.org then run this command again."
  exit 1
fi

BASE="https://olkil.com/downloads/cli"
CLI_DIR="${HOME}/.olkil/cli"
BIN_DIR="${HOME}/.olkil/bin"
mkdir -p "$CLI_DIR" "$BIN_DIR"

echo "Installing OLKIL CLI..."
curl -fsSL "$BASE/olkil.cjs" -o "$CLI_DIR/olkil.cjs"
cat > "$BIN_DIR/olkil" <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/.olkil/cli/olkil.cjs" "$@"
EOF
chmod +x "$BIN_DIR/olkil"

SHELL_NAME="$(basename "${SHELL:-bash}")"
RC=""
case "$SHELL_NAME" in
  zsh) RC="${HOME}/.zshrc" ;;
  fish) RC="${HOME}/.config/fish/config.fish" ;;
  *) RC="${HOME}/.bashrc" ;;
esac

EXPORT_LINE='export PATH="$HOME/.olkil/bin:$PATH"'
if [ "$SHELL_NAME" = "fish" ]; then
  EXPORT_LINE='set -gx PATH $HOME/.olkil/bin $PATH'
fi
if [ -f "$RC" ] && ! grep -q '.olkil/bin' "$RC" 2>/dev/null; then
  printf '\n# OLKIL CLI\n%s\n' "$EXPORT_LINE" >> "$RC"
elif [ ! -f "$RC" ]; then
  printf '# OLKIL CLI\n%s\n' "$EXPORT_LINE" >> "$RC"
fi
export PATH="$HOME/.olkil/bin:$PATH"

echo ""
echo "OLKIL CLI installed."
echo "Open a new terminal, then run:  olkil"
echo ""
