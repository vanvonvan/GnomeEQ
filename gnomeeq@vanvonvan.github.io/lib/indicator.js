// The top-bar indicator: on/off, preset picker, ten band sliders, preamp,
// and an output-device chooser.
//
// GSettings is the source of truth throughout. Every control writes a setting;
// the settings' own `changed` signals then drive both the widgets and the
// filter graph. That one-way flow is what keeps the sliders, the preset dot
// and the audio from ever disagreeing — including when Preferences is open in
// another process and changes the same keys.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import * as C from './constants.js';
import * as Presets from './presets.js';

// How far one arrow-key press moves a slider, in dB.
const KEY_STEP_DB = 1;

// One labelled slider: "125  ----o----  +3".
const BandRow = GObject.registerClass(
class BandRow extends PopupMenu.PopupBaseMenuItem {
    _init(label, min, max, onChange, styleClass = null) {
        // activate:false keeps the menu open while dragging — a slider that
        // dismissed its own menu on release would be unusable.
        super._init({ activate: false, reactive: true, can_focus: true });
        if (styleClass)
            this.add_style_class_name(styleClass);
        this._min = min;
        this._max = max;
        this._onChange = onChange;
        this._notifying = false;

        this._label = new St.Label({
            text: label,
            style_class: 'gnomeeq-band-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._value = new St.Label({
            text: '0',
            style_class: 'gnomeeq-band-value',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this._label);
        this.add_child(this._slider);
        this.add_child(this._value);

        this._slider.connect('notify::value', () => {
            if (this._notifying)
                return;
            this._value.text = C.formatDb(this.db);
            this._onChange(this.db);
        });
    }

    get db() {
        return this._min + this._slider.value * (this._max - this._min);
    }

    setDb(db) {
        // Guard the write-back so programmatic updates do not re-enter
        // _onChange and fight whatever set them.
        this._notifying = true;
        this._slider.value = C.clamp(
            (db - this._min) / (this._max - this._min), 0, 1);
        this._notifying = false;
        this._value.text = C.formatDb(db);
    }

    setDimmed(dimmed) {
        this.opacity = dimmed ? 120 : 255;
        this._slider.reactive = !dimmed;
    }

    // Nudge with the arrow keys once the row has focus. Implemented here
    // rather than delegating to the Slider's own key handling, which has
    // moved between Shell versions.
    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        let delta = 0;
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_KP_Left)
            delta = -KEY_STEP_DB;
        else if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_KP_Right)
            delta = KEY_STEP_DB;
        else
            return super.vfunc_key_press_event(event);

        const next = C.clamp(Math.round(this.db) + delta, this._min, this._max);
        this.setDb(next);
        this._onChange(next);
        return Clutter.EVENT_STOP;
    }
});

export const GnomeEQIndicator = GObject.registerClass(
class GnomeEQIndicator extends PanelMenu.Button {
    _init(extension, engine) {
        super._init(0.0, 'GnomeEQ');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._engine = engine;
        this._settingsIds = [];
        this._bandRows = [];
        this._presetItems = [];
        this._syncing = false;

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/gnomeeq-symbolic.svg`),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        this._buildMenu();
        this._watchSettings();
        this._syncFromSettings();

        // The device list is only known once pw-dump answers, so populate it
        // when the menu opens rather than holding a stale list.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refreshDeviceMenu();
            } else {
                // Collapse everything so the next open starts from the default
                // layout instead of whatever was expanded last time.
                this._closeSaveEntry();
                this._presetMenu.menu.close(false);
                this._deviceMenu.menu.close(false);
                this._syncVisibility();
            }
        });
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }

    // --- Menu construction ------------------------------------------------

    _buildMenu() {
        // On/off drives the bands flat rather than re-routing audio: pulling
        // the default sink out from under running streams is far more
        // disruptive than making the chain transparent.
        this._toggle = new PopupMenu.PopupSwitchMenuItem('Equalizer', true);
        this._toggle.connect('toggled', (_item, state) =>
            this._settings.set_boolean(C.Keys.ENABLED, state));
        this.menu.addMenuItem(this._toggle);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._presetMenu = new PopupMenu.PopupSubMenuMenuItem('Preset', true);
        this._presetMenu.icon.icon_name = 'view-list-symbolic';
        this.menu.addMenuItem(this._presetMenu);
        this._rebuildPresetMenu();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._bandSection = new PopupMenu.PopupMenuSection();
        for (const band of C.BANDS) {
            // Tint the row by the perceptual range the band belongs to.
            const row = new BandRow(band.label, C.GAIN_MIN, C.GAIN_MAX,
                () => this._onBandChanged(), C.groupFor(band.freq).css);
            this._bandRows.push(row);
            this._bandSection.addMenuItem(row);
        }
        this.menu.addMenuItem(this._bandSection);

        this._preampRow = new BandRow('Pre', C.PREAMP_MIN, C.PREAMP_MAX,
            db => this._onPreampChanged(db), 'gnomeeq-group-none');
        this._preampRow._label.add_style_class_name('gnomeeq-preamp-label');
        this._bandSection.addMenuItem(this._preampRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const flatten = new PopupMenu.PopupMenuItem('Reset to flat');
        flatten.connect('activate', () => this._applyPreset('Flat'));
        this.menu.addMenuItem(flatten);

        this._saveItem = new PopupMenu.PopupMenuItem('Save current as preset…');
        this._saveItem.connect('activate', () => this._openSaveEntry());
        this.menu.addMenuItem(this._saveItem);

        // Inline name entry, revealed by the item above.
        this._saveRow = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: true,
            can_focus: false,
        });
        this._saveEntry = new St.Entry({
            hint_text: 'Preset name, then Enter',
            style_class: 'gnomeeq-entry',
            can_focus: true,
            x_expand: true,
        });
        this._saveEntry.clutter_text.connect('activate', () => this._commitSave());
        this._saveEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeSaveEntry();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._saveRow.add_child(this._saveEntry);
        this._saveRow.visible = false;
        this.menu.addMenuItem(this._saveRow);

        this._deviceMenu = new PopupMenu.PopupSubMenuMenuItem('Output device', true);
        this._deviceMenu.icon.icon_name = 'audio-speakers-symbolic';
        this.menu.addMenuItem(this._deviceMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefs = new PopupMenu.PopupMenuItem('Settings');
        prefs.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefs);

        this._wireSpaceSharing();
    }

    // The band sliders are eleven rows tall. On a small screen that leaves a
    // submenu no room to expand into — the preset list would open and simply
    // not be visible. So the sliders and the expandable sections share the
    // space: opening one collapses the others.
    _wireSpaceSharing() {
        for (const [item, other] of [
            [this._presetMenu, this._deviceMenu],
            [this._deviceMenu, this._presetMenu],
        ]) {
            item.menu.connect('open-state-changed', (_submenu, open) => {
                if (open) {
                    // One expanded section at a time, or the menu grows tall
                    // again and we are back to the original problem.
                    other.menu.close(false);
                    this._closeSaveEntry();
                }
                this._syncVisibility();
            });
        }
    }

    _rebuildPresetMenu() {
        this._presetMenu.menu.removeAll();
        this._presetItems = [];
        const json = this._settings.get_string(C.Keys.USER_PRESETS);
        let sawUser = false;
        for (const preset of Presets.allPresets(json)) {
            if (!preset.builtin && !sawUser) {
                sawUser = true;
                this._presetMenu.menu.addMenuItem(
                    new PopupMenu.PopupSeparatorMenuItem());
            }
            const item = new PopupMenu.PopupMenuItem(preset.name);
            item._presetName = preset.name;
            item.connect('activate', () => this._applyPreset(preset.name));
            this._presetMenu.menu.addMenuItem(item);
            this._presetItems.push(item);
        }
    }

    _refreshDeviceMenu() {
        // Fire and forget: the menu is already on screen, and the device list
        // fills in a frame later when pw-dump answers.
        this._populateDeviceMenu().catch(() => {});
    }

    async _populateDeviceMenu() {
        const devices = await this._engine.listOutputDevices();
        const current = await this._engine.currentOutputDevice();
        this._deviceMenu.menu.removeAll();

        const auto = new PopupMenu.PopupMenuItem('Automatic');
        auto.setOrnament(this._settings.get_string(C.Keys.OUTPUT_DEVICE) === ''
            ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        auto.connect('activate', () => this._selectDevice(''));
        this._deviceMenu.menu.addMenuItem(auto);

        for (const device of devices) {
            const item = new PopupMenu.PopupMenuItem(device.description);
            item.setOrnament(device.name === current
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._selectDevice(device.name));
            this._deviceMenu.menu.addMenuItem(item);
        }
        if (devices.length === 0) {
            const none = new PopupMenu.PopupMenuItem('No outputs found');
            none.setSensitive(false);
            this._deviceMenu.menu.addMenuItem(none);
        }
    }

    // --- Actions ----------------------------------------------------------

    _selectDevice(nodeName) {
        this._settings.set_string(C.Keys.OUTPUT_DEVICE, nodeName);
        this._engine.setOutputDevice(nodeName).catch(() => {});
        // Choosing an output here must not hand the default sink to that
        // device, or audio would stop passing through the chain.
        if (this._settings.get_boolean(C.Keys.CLAIM_SINK))
            this._engine.claimDefaultSink().catch(() => {});
    }

    _applyPreset(name) {
        const preset = Presets.findPreset(
            this._settings.get_string(C.Keys.USER_PRESETS), name);
        if (!preset)
            return;
        this._settings.set_string(C.Keys.PRESET, name);
        this._settings.set_value(C.Keys.GAINS,
            new GLib.Variant('ad', preset.gains));
    }

    _onBandChanged() {
        if (this._syncing)
            return;
        this._writeGains(this._bandRows.map(row => row.db));
    }

    _writeGains(gains) {
        // Editing a slider makes this a curve of its own unless it happens to
        // land exactly on a stored preset.
        const match = Presets.matchPreset(
            this._settings.get_string(C.Keys.USER_PRESETS), gains);
        this._settings.set_string(C.Keys.PRESET, match ?? '');
        this._settings.set_value(C.Keys.GAINS, new GLib.Variant('ad', gains));
    }

    _onPreampChanged(db) {
        if (this._syncing)
            return;
        // Touching the preamp by hand means the user wants that value, so
        // stop deriving it from the band peaks.
        if (this._settings.get_boolean(C.Keys.AUTO_PREAMP))
            this._settings.set_boolean(C.Keys.AUTO_PREAMP, false);
        this._settings.set_double(C.Keys.PREAMP, db);
    }

    _openSaveEntry() {
        this._presetMenu.menu.close(false);
        this._deviceMenu.menu.close(false);
        this._saveEntry.set_text('');
        this._saveRow.visible = true;
        this._syncVisibility();
        this._saveEntry.grab_key_focus();
    }

    _closeSaveEntry() {
        // Guarded so the submenu handlers can call this freely without
        // re-entering _syncVisibility on every open-state change.
        if (!this._saveRow.visible)
            return;
        this._saveRow.visible = false;
        this._saveEntry.set_text('');
        this._syncVisibility();
    }

    _commitSave() {
        const name = this._saveEntry.get_text();
        const gains = this._bandRows.map(row => row.db);
        const result = Presets.addUserPreset(
            this._settings.get_string(C.Keys.USER_PRESETS), name, gains);
        if (!result.ok) {
            Main.notify('GnomeEQ', result.error);
            return;
        }
        this._settings.set_string(C.Keys.USER_PRESETS, result.json);
        this._settings.set_string(C.Keys.PRESET, Presets.normalizeName(name));
        this._closeSaveEntry();
        this.menu.close();
    }

    // --- Settings -> UI ---------------------------------------------------

    _watchSettings() {
        const watch = (key, fn) => {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        };
        watch(C.Keys.GAINS, () => this._syncFromSettings());
        watch(C.Keys.PREAMP, () => this._syncFromSettings());
        watch(C.Keys.ENABLED, () => this._syncFromSettings());
        watch(C.Keys.AUTO_PREAMP, () => this._syncFromSettings());
        watch(C.Keys.PRESET, () => this._syncPresetDots());
        watch(C.Keys.SHOW_SLIDERS, () => this._syncVisibility());
        watch(C.Keys.USER_PRESETS, () => {
            this._rebuildPresetMenu();
            this._syncPresetDots();
        });
    }

    _syncFromSettings() {
        this._syncing = true;
        try {
            const gains = C.sanitizeGains(
                this._settings.get_value(C.Keys.GAINS).deep_unpack());
            this._bandRows.forEach((row, i) => row.setDb(gains[i]));

            const preamp = this._settings.get_boolean(C.Keys.AUTO_PREAMP)
                ? C.autoPreampFor(gains)
                : this._settings.get_double(C.Keys.PREAMP);
            this._preampRow.setDb(preamp);

            const on = this._settings.get_boolean(C.Keys.ENABLED);
            this._toggle.setToggleState(on);
            if (on)
                this._icon.remove_style_class_name('gnomeeq-icon-off');
            else
                this._icon.add_style_class_name('gnomeeq-icon-off');
            for (const row of this._bandRows)
                row.setDimmed(!on);
            this._preampRow.setDimmed(!on);
        } finally {
            this._syncing = false;
        }
        this._syncPresetDots();
        this._syncVisibility();
    }

    // True when something expandable is using the vertical space.
    _spaceInUse() {
        return Boolean(this._presetMenu?.menu.isOpen ||
            this._deviceMenu?.menu.isOpen ||
            this._saveRow?.visible);
    }

    _syncVisibility() {
        const show = this._settings.get_boolean(C.Keys.SHOW_SLIDERS) &&
            !this._spaceInUse();
        for (const row of this._bandRows)
            row.visible = show;
        this._preampRow.visible = show;
    }

    _syncPresetDots() {
        const current = this._settings.get_string(C.Keys.PRESET);
        for (const item of this._presetItems) {
            item.setOrnament(item._presetName === current
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        }
        this._presetMenu.label.text = current === ''
            ? `Preset: ${C.CUSTOM_LABEL}`
            : `Preset: ${current}`;
    }
});
