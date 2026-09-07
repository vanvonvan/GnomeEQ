#!/usr/bin/env bash
# Launch a VISIBLE, isolated nested GNOME Shell via the devkit backend, with
# GnomeEQ enabled, so the panel menu can be tested without logging out.
#
# Why the devkit and not `gnome-shell --wayland`: on this machine (NVIDIA,
# mutter 50.1) a plain `--wayland` compositor tries to become a native display
# server and dies with `EBUSY: Failed to take control of the session`. The
# devkit backend renders into a nested virtual monitor over EGL/GBM instead.
#
#   1. `dbus-run-session` gives it its own session bus, so it does not collide
#      with the live shell (`org.gnome.Shell already exists on bus`).
#   2. An isolated XDG_CONFIG_HOME keeps dconf writes (enabling the extension,
#      any slider changes) out of the real configuration. This matters: a bare
#      `gsettings set` hits the LIVE dconf service and would clobber the real
#      enabled-extensions list.
#
# The extension is found via ~/.local/share (XDG_DATA_HOME, unchanged), so the
# `make link` symlink is what gets loaded — the nested shell serves live repo
# code, unlike the real session which caches ESM modules until logout.
#
# NOTE: the nested shell shares the audio graph with the live session, so
# changing bands in there really does change this machine's sound.
set -euo pipefail

UUID="gnomeeq@vanvonvan.github.io"
ISO="$(mktemp -d)"
MARKER="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"

cleanup() { rm -rf "$ISO"; rm -f "$MARKER"; }
trap cleanup EXIT

echo "Devkit GNOME Shell — GnomeEQ enabled, isolated config at $ISO"
echo "Close the nested window (or Ctrl+C here) to quit."

XDG_CONFIG_HOME="$ISO" dbus-run-session -- bash -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['$UUID']\"
  exec gnome-shell --devkit
"
