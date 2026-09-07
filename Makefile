UUID = gnomeeq@vanvonvan.github.io
EXT_SRC = $(UUID)
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(EXT_SRC)/schemas
CONF_DIR = $(HOME)/.config/pipewire/filter-chain.conf.d

.PHONY: all schemas conf install-conf test verify link install uninstall pack nested devkit

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

# Launch a VISIBLE nested GNOME Shell (a window on your desktop) with GnomeEQ
# enabled. This is the way to click the menu without logging out. Plain
# `--wayland` is nested by default — it is `--display-server` (implied by
# `--devkit`) that makes a shell take over the screen instead.
nested: link
	bash tools/run-nested.sh

# Same, but via the devkit backend. NOTE: `--devkit` implies display-server
# mode, so it renders into a virtual monitor and shows NO window — useful only
# for headless load checks. Prefer `make nested` for interactive testing.
devkit: link
	bash tools/run-devkit.sh
