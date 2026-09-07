#!/usr/bin/env -S gjs -m
// Checks that every shipped asset the Shell has to load actually loads.
// Run: gjs -m tests/assets-smoke.js
//
// This exists because a broken panel icon fails SILENTLY: St.Icon renders
// nothing, the button stays clickable, and no JS error is logged — so the only
// symptom is a user saying "I can't see the icon". The specific trap: an XML
// comment between the <?xml?> declaration and the <svg> root element makes
// GdkPixbuf refuse the file with "Couldn't recognize the image file format".
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

const UUID = 'gnomeeq@vanvonvan.github.io';

let failures = 0;
function check(name, cond) {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond)
        failures++;
}

// Resolve the repo root from this file's own location so the test can be run
// from anywhere.
const here = GLib.path_get_dirname(
    import.meta.url.replace('file://', ''));
const root = GLib.path_get_dirname(here);

const icons = [`${root}/${UUID}/icons/gnomeeq-symbolic.svg`];

for (const path of icons) {
    const name = GLib.path_get_basename(path);
    check(`${name} exists`, Gio.File.new_for_path(path).query_exists(null));

    // The real test: does the image loader accept it at panel size?
    let pixbuf = null;
    let error = null;
    try {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 16, 16);
    } catch (e) {
        error = e;
    }
    check(`${name} loads as an image${error ? ` (${error.message})` : ''}`,
        pixbuf !== null);
    if (!pixbuf)
        continue;

    check(`${name} is 16x16 at panel size`,
        pixbuf.get_width() === 16 && pixbuf.get_height() === 16);

    // And does it actually draw anything? A file can parse and still be blank.
    let opaque = 0;
    const data = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    if (channels === 4) {
        for (let i = 3; i < data.length; i += channels) {
            if (data[i] > 0)
                opaque++;
        }
    }
    check(`${name} renders visible pixels (${opaque} opaque)`, opaque > 20);

    // Guard the exact regression: nothing but whitespace between the XML
    // declaration and the root element.
    const [ok, bytes] = GLib.file_get_contents(path);
    const text = ok ? new TextDecoder().decode(bytes) : '';
    const between = text.slice(
        text.indexOf('?>') + 2,
        text.indexOf('<svg'));
    check(`${name} has no comment before its <svg> root`,
        between.trim() === '');

    check(`${name} is symbolic (recolors to the panel foreground)`,
        name.endsWith('-symbolic.svg') && text.includes('currentColor'));
}

// --- Stylesheet backs every group class the indicator will apply ---
// A renamed or missing class is silent: the row simply renders untinted.
const cssPath = `${root}/${UUID}/stylesheet.css`;
const [cssOk, cssBytes] = GLib.file_get_contents(cssPath);
const css = cssOk ? new TextDecoder().decode(cssBytes) : '';
check('stylesheet.css is readable', css.length > 0);

const groupClasses = [
    'gnomeeq-group-subbass', 'gnomeeq-group-bass', 'gnomeeq-group-lowermids',
    'gnomeeq-group-midrange', 'gnomeeq-group-uppermids',
    'gnomeeq-group-treble', 'gnomeeq-group-none',
];
for (const cls of groupClasses)
    check(`stylesheet defines .${cls}`, css.includes(`.${cls}`));

// Each tinted group needs a :hover rule too: the shell's own hover highlight
// is a background-color, so a group tint without one eats the feedback.
for (const cls of groupClasses.filter(c => c !== 'gnomeeq-group-none'))
    check(`.${cls} keeps its hover feedback`, css.includes(`.${cls}:hover`));

print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);
