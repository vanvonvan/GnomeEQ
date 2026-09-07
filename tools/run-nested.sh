#!/usr/bin/env bash
# Launch a VISIBLE nested GNOME Shell — a window on your desktop — with GnomeEQ
# enabled, so the panel menu can be clicked without logging out.
#
# The key flag is the one that is NOT here: `--display-server`. Per
# `gnome-shell --help-all`, that flag means "run as a full display server,
# rather than nested", so plain `--wayland` is NESTED by default and appears as
# a window. `--devkit` implies display-server mode, which is why `make devkit`
# renders into a virtual monitor (log: "Added virtual monitor Meta-0") and puts
# nothing on screen.
#
# Requirements: WAYLAND_DISPLAY must point at the host compositor so the nested
# shell can connect to it as a client. dbus-run-session preserves it.
#
#   1. `dbus-run-session` gives it its own session bus, so it does not collide
#      with the live shell (`org.gnome.Shell already exists on bus`).
#   2. An isolated XDG_CONFIG_HOME keeps dconf writes out of the real config.
#      This matters: a bare `gsettings set` hits the LIVE dconf service and
#      would clobber the real enabled-extensions list.
#
# The extension is found via ~/.local/share (XDG_DATA_HOME, unchanged), so the
# `make link` symlink is what loads — live repo code, no logout needed.
#
# NOTE: the nested shell shares the audio graph with the live session, so
# moving a band in there really does change this machine's sound.
set -euo pipefail

UUID="gnomeeq@vanvonvan.github.io"
ISO="$(mktemp -d)"
NESTED_DISPLAY="wayland-gnomeeq"

cleanup() { rm -rf "$ISO"; }
trap cleanup EXIT

if [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "WAYLAND_DISPLAY is unset — a nested shell has no compositor to" >&2
    echo "connect to and would try to become a display server. Aborting." >&2
    exit 1
fi

echo "Nested GNOME Shell — GnomeEQ enabled, isolated config at $ISO"
echo "Host compositor: $WAYLAND_DISPLAY   nested display: $NESTED_DISPLAY"
echo "A window should open. Close it (or Ctrl+C here) to quit."

XDG_CONFIG_HOME="$ISO" dbus-run-session -- bash -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['$UUID']\"
  exec gnome-shell --wayland --wayland-display=$NESTED_DISPLAY
"
