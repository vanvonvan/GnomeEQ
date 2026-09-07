UUID = gnomeeq@vanvonvan.github.io
EXT_SRC = $(UUID)
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(EXT_SRC)/schemas
CONF_DIR = $(HOME)/.config/pipewire/filter-chain.conf.d

.PHONY: all schemas conf install-conf test verify link install uninstall pack devkit

all: schemas conf

# Compile the GSettings schema in place (needed for dev and for packing).
schemas:
	glib-compile-schemas $(SCHEMA_DIR)

# Regenerate the PipeWire filter-chain config the extension ships and
# installs. The band table in tools/gen_sink_conf.py is the source of truth
# and must stay in step with lib/constants.js.
conf:
	python3 tools/gen_sink_conf.py $(EXT_SRC)/data/gnomeeq-sink.conf

# Install the chain config by hand and restart the daemon that serves it.
# The extension does this itself on first enable; this is for development.
install-conf: conf
	mkdir -p $(CONF_DIR)
	cp $(EXT_SRC)/data/gnomeeq-sink.conf $(CONF_DIR)/99-gnomeeq-sink.conf
	systemctl --user restart filter-chain.service
	@echo "Installed the chain and restarted filter-chain.service"

# Headless logic tests — pure data/maths, no shell and no audio needed.
# Depends on `schemas` because editing the .gschema.xml does not recompile it,
# and a stale gschemas.compiled silently ships a wrong default.
test: schemas
	python3 tools/gen_sink_conf.py --check
	gjs -m tests/constants-smoke.js
	gjs -m tests/presets-smoke.js
	gjs -m tests/assets-smoke.js

# Prove the DSP by MEASURING it: pushes a multi-tone probe through the sink
# into a temporary null sink and checks every band and the preamp with a DFT.
# Silent, and restores the original routing when it finishes. Needs numpy.
verify:
	python3 tools/verify_eq.py

# Symlink the extension source into the extensions dir for live development.
link: schemas conf
	mkdir -p $(HOME)/.local/share/gnome-shell/extensions
	rm -rf $(EXT_DIR)
	ln -sfn $(CURDIR)/$(EXT_SRC) $(EXT_DIR)
	@echo "Linked $(CURDIR)/$(EXT_SRC) -> $(EXT_DIR)"

# Copy (not link) an installed build.
install: schemas conf
	mkdir -p $(EXT_DIR)
	cp -r $(EXT_SRC)/metadata.json $(EXT_SRC)/extension.js $(EXT_SRC)/prefs.js \
		$(EXT_SRC)/stylesheet.css $(EXT_SRC)/lib $(EXT_SRC)/schemas \
		$(EXT_SRC)/icons $(EXT_SRC)/data $(EXT_DIR)/
	@echo "Installed to $(EXT_DIR)"

uninstall:
	rm -rf $(EXT_DIR)

# Build a distributable zip.
pack: schemas conf
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=icons \
		--extra-source=data \
		$(EXT_SRC)

# Launch an isolated nested GNOME Shell with GnomeEQ enabled, to click the
# menu without logging out.
#
# The window is easy to miss: `gnome-shell --devkit` is its own display server
# (it creates wayland-1 and never connects to the host's wayland-0), and the
# thing you actually see is the separate `mutter-devkit` process, a viewer onto
# the nested session's virtual monitor. It carries no useful title — find it
# with Alt+Tab or the overview and look for "mutter-devkit".
#
# Note `gnome-shell --wayland` is NOT an alternative: despite --help-all
# advertising --display-server as "rather than nested", plain --wayland takes
# the native backend and dies with "Failed to take control of the session:
# EBUSY" whenever a compositor already owns the seat.
#
# The nested shell shares the real audio graph, so moving a band in there does
# change this machine's sound. Its dconf is isolated, so presets saved in there
# do not persist.
devkit: link
	bash tools/run-devkit.sh
