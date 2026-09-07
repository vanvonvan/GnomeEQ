// GnomeEQ preferences — engine setup, behaviour, and preset housekeeping.
//
// The band sliders deliberately live in the panel menu, not here: adjusting
// an equalizer is something you do while listening, so it belongs one click
// away rather than behind a settings window. What is here is the stuff you
// set once.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as C from './lib/constants.js';
import * as Presets from './lib/presets.js';
import { PipeWireEQ } from './lib/pipewire.js';

export default class GnomeEQPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const engine = new PipeWireEQ(this.path);
        // The engine spawns subprocesses; drop them with the window.
        window.connect('close-request', () => engine.destroy());

        const page = new Adw.PreferencesPage({
            title: 'GnomeEQ',
            icon_name: 'audio-card-symbolic',
        });

        page.add(this._engineGroup(settings, engine));
        page.add(this._behaviourGroup(settings));
        page.add(this._presetGroup(settings, window));

        window.add(page);
    }

    // --- Engine -----------------------------------------------------------

    _engineGroup(settings, engine) {
        const group = new Adw.PreferencesGroup({
            title: 'Audio engine',
            description: 'GnomeEQ equalizes everything by routing the ' +
                'default output through a PipeWire filter chain.',
        });

        const status = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Checking…',
        });
        const refresh = () => {
            engine.isEngineRunning().then(running => {
                status.subtitle = running
                    ? 'The GnomeEQ sink is present.'
                    : 'The GnomeEQ sink is not running.';
            }).catch(() => {
                status.subtitle = 'Could not query PipeWire.';
            });
        };
        refresh();
        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Re-check',
        });
        refreshButton.connect('clicked', refresh);
        status.add_suffix(refreshButton);
        group.add(status);

        const claim = new Adw.SwitchRow({
            title: 'Use GnomeEQ as the default output',
            subtitle: 'Apps follow the default output, so this is what makes ' +
                'the equalizer apply to every app.',
        });
        settings.bind(C.Keys.CLAIM_SINK, claim, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(claim);

        // Reinstalling rewrites the chain config and restarts the
        // filter-chain daemon, which interrupts audio for about a second.
        const reinstall = new Adw.ActionRow({
            title: 'Reinstall the audio engine',
            subtitle: 'Rewrites the filter chain and restarts it. ' +
                'Audio cuts out briefly.',
        });
        const reinstallButton = new Gtk.Button({
            label: 'Reinstall',
            valign: Gtk.Align.CENTER,
        });
        reinstallButton.connect('clicked', () => {
            reinstallButton.sensitive = false;
            engine.installEngine()
                .then(() => engine.isEngineRunning())
                .then(() => {
                    reinstallButton.sensitive = true;
                    refresh();
                })
                .catch(() => {
                    reinstallButton.sensitive = true;
                    status.subtitle = 'Reinstall failed.';
                });
        });
        reinstall.add_suffix(reinstallButton);
        group.add(reinstall);

        return group;
    }

    // --- Behaviour --------------------------------------------------------

    _behaviourGroup(settings) {
        const group = new Adw.PreferencesGroup({ title: 'Behaviour' });

        const autoPreamp = new Adw.SwitchRow({
            title: 'Automatic preamp',
            subtitle: 'Boosting bands can clip. When on, the preamp is set ' +
                'to cancel the largest boost.',
        });
        settings.bind(C.Keys.AUTO_PREAMP, autoPreamp, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(autoPreamp);

        const preamp = new Adw.SpinRow({
            title: 'Preamp',
            subtitle: 'Applied ahead of the bands, in dB.',
            adjustment: new Gtk.Adjustment({
                lower: C.PREAMP_MIN,
                upper: C.PREAMP_MAX,
                step_increment: 0.5,
                page_increment: 2,
            }),
            digits: 1,
        });
        settings.bind(C.Keys.PREAMP, preamp, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        // A manual value is meaningless while the preamp is being derived.
        const syncPreampRow = () => {
            preamp.sensitive = !settings.get_boolean(C.Keys.AUTO_PREAMP);
        };
        settings.connect(`changed::${C.Keys.AUTO_PREAMP}`, syncPreampRow);
        syncPreampRow();
        group.add(preamp);

        const sliders = new Adw.SwitchRow({
            title: 'Show band sliders in the menu',
            subtitle: 'Turn off for a compact menu with just the presets.',
        });
        settings.bind(C.Keys.SHOW_SLIDERS, sliders, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(sliders);

        return group;
    }

    // --- Presets ----------------------------------------------------------

    _presetGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Your presets',
            description: 'Save presets from the panel menu. Built-in presets ' +
                'cannot be removed.',
        });

        const rebuild = () => {
            for (const row of group._rows ?? [])
                group.remove(row);
            group._rows = [];

            const json = settings.get_string(C.Keys.USER_PRESETS);
            const saved = Presets.parseUserPresets(json);

            if (saved.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'No saved presets yet',
                    subtitle: 'Adjust the sliders, then use ' +
                        '“Save current as preset…”.',
                });
                empty.sensitive = false;
                group.add(empty);
                group._rows.push(empty);
                return;
            }

            for (const [name, gains] of saved) {
                const row = new Adw.ActionRow({
                    title: name,
                    subtitle: gains.map(g => C.formatDb(g)).join('  '),
                });
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: `Delete “${name}”`,
                });
                remove.connect('clicked', () => {
                    settings.set_string(C.Keys.USER_PRESETS,
                        Presets.removeUserPreset(
                            settings.get_string(C.Keys.USER_PRESETS), name));
                    // Deleting the selected preset leaves the curve in place
                    // but it is no longer a named preset.
                    if (settings.get_string(C.Keys.PRESET) === name)
                        settings.set_string(C.Keys.PRESET, '');
                });
                row.add_suffix(remove);
                group.add(row);
                group._rows.push(row);
            }
        };

        const id = settings.connect(`changed::${C.Keys.USER_PRESETS}`, rebuild);
        window.connect('close-request', () => settings.disconnect(id));
        rebuild();

        return group;
    }
}
