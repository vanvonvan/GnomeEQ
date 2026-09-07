#!/usr/bin/env -S gjs -m
// Headless checks for the pure data/maths in constants.js.
// Run: gjs -m tests/constants-smoke.js
import * as C from '../gnomeeq@vanvonvan.github.io/lib/constants.js';

let failures = 0;
function check(name, cond) {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond)
        failures++;
}

// --- Band table integrity ---
check('eleven bands', C.BAND_COUNT === 11);
check('bands ascend in frequency',
    C.BANDS.every((b, i) => i === 0 || b.freq > C.BANDS[i - 1].freq));
// The ISO 266 one-octave series. ISO rounds some centres (315/630/1250 stand
// in for 320/640/1280), so steps are near 2 rather than exactly 2 — the
// tolerance below admits that rounding but would still catch a wrong entry.
check('every step is close to one octave',
    C.BANDS.every((b, i) => {
        if (i === 0)
            return true;
        const r = b.freq / C.BANDS[i - 1].freq;
        return r > 1.93 && r < 2.07;
    }));
check('the grid spans 20 Hz to 20 kHz',
    C.BANDS[0].freq === 20 && C.BANDS[C.BANDS.length - 1].freq === 20000);
// Eleven bands over the span means ten steps whose geometric mean must be
// (20000/20)^(1/10) = 1.9953. This is what Q is derived from, so it is the
// number that actually matters.
check('mean spacing is one octave within 0.5%', (() => {
    const n = C.BAND_COUNT - 1;
    const gm = (C.BANDS[n].freq / C.BANDS[0].freq) ** (1 / n);
    return Math.abs(gm - 1.9953) < 0.01;
})());
check('centres are the round ISO preferred values',
    [20, 40, 80, 160, 315, 630, 1250, 2500, 5000, 10000, 20000]
        .every((f, i) => C.BANDS[i].freq === f));
check('labels are present and short enough for the column',
    C.BANDS.every(b => b.label.length > 0 && b.label.length <= 5));
check('FLAT has one entry per band', C.FLAT.length === C.BAND_COUNT);

// --- Frequency-range groups ---
// The boundaries are the conventional perceptual ranges. `until` is
// exclusive, so a band sitting exactly on a boundary belongs to the range
// above: 2 kHz is upper-mids, not midrange.
const g = f => C.groupFor(f).key;
check('20 Hz is sub-bass', g(20) === 'subbass');
check('just under 60 Hz is still sub-bass', g(59.9) === 'subbass');
check('60 Hz is bass', g(60) === 'bass');
check('just under 250 Hz is still bass', g(249.9) === 'bass');
check('250 Hz is lower mids', g(250) === 'lowermids');
check('just under 500 Hz is still lower mids', g(499.9) === 'lowermids');
check('500 Hz is midrange', g(500) === 'midrange');
check('just under 2 kHz is still midrange', g(1999.9) === 'midrange');
check('2 kHz is upper mids', g(2000) === 'uppermids');
check('just under 4 kHz is still upper mids', g(3999.9) === 'uppermids');
check('4 kHz is treble', g(4000) === 'treble');
check('20 kHz is treble', g(20000) === 'treble');
check('groupFor never returns nothing, even absurdly high',
    C.groupFor(1e9)?.key === 'treble');
check('every band resolves to a group',
    C.BANDS.every(b => C.groupFor(b.freq) !== undefined));
check('group assignment rises with frequency (never goes backwards)',
    C.BANDS.every((b, i) => {
        if (i === 0)
            return true;
        const prev = C.GROUPS.findIndex(x => x.key === g(C.BANDS[i - 1].freq));
        return C.GROUPS.findIndex(x => x.key === g(b.freq)) >= prev;
    }));
check('group boundaries ascend and end at Infinity',
    C.GROUPS.every((x, i) => i === 0 || x.until > C.GROUPS[i - 1].until) &&
    C.GROUPS[C.GROUPS.length - 1].until === Infinity);
check('every group has a key, a name and a css class',
    C.GROUPS.every(x => x.key && x.name && x.css?.startsWith('gnomeeq-group-')));
check('group css classes are unique',
    new Set(C.GROUPS.map(x => x.css)).size === C.GROUPS.length);
check('all six ranges are actually used by some band',
    new Set(C.BANDS.map(b => g(b.freq))).size >= 6);

// --- Presets ---
check('every builtin preset has one gain per band',
    C.BUILTIN_PRESETS.every(([, g]) => g.length === C.BAND_COUNT));
check('every builtin gain is within the UI range',
    C.BUILTIN_PRESETS.every(([, g]) =>
        g.every(v => v >= C.GAIN_MIN && v <= C.GAIN_MAX)));
check('Flat is first and actually flat',
    C.BUILTIN_PRESETS[0][0] === 'Flat' &&
    C.BUILTIN_PRESETS[0][1].every(v => v === 0));
check('preset names are unique',
    new Set(C.BUILTIN_PRESETS.map(([n]) => n)).size === C.BUILTIN_PRESETS.length);

// --- Preamp maths ---
// A preamp exists to stop boosted presets clipping, so it must cancel the
// largest positive gain and must NOT attenuate a preset that only cuts.
check('dbToMult(0) === 1', Math.abs(C.dbToMult(0) - 1) < 1e-9);
check('dbToMult(-6) ~ 0.5012', Math.abs(C.dbToMult(-6) - 0.5012) < 1e-3);
check('dbToMult(+20) ~ 10', Math.abs(C.dbToMult(20) - 10) < 1e-6);
check('autoPreamp cancels the largest boost',
    C.autoPreampFor([7, 6, 4, 2, 0, 0, 0, 0, 0, 0]) === -7);
check('autoPreamp leaves a cut-only preset alone',
    C.autoPreampFor([-5, -4, 0, -2, 0, 0, 0, 0, 0, 0]) === 0);
check('autoPreamp of flat is 0', C.autoPreampFor(C.FLAT) === 0);
check('autoPreamp never exceeds the preamp range',
    C.autoPreampFor(new Array(10).fill(C.GAIN_MAX)) >= C.PREAMP_MIN);

// --- Sanitizing (guards against hand-edited dconf / imported presets) ---
check('sanitize pads a short array',
    C.sanitizeGains([1, 2]).length === C.BAND_COUNT);
check('sanitize zeroes non-numbers',
    C.sanitizeGains(['x', null, undefined, NaN])
        .slice(0, 4).every(v => v === 0));
check('sanitize clamps out-of-range values',
    C.sanitizeGains([999, -999])[0] === C.GAIN_MAX &&
    C.sanitizeGains([999, -999])[1] === C.GAIN_MIN);
check('sanitize of a non-array is flat',
    C.gainsEqual(C.sanitizeGains('nonsense'), C.FLAT));
check('sanitize truncates a long array',
    C.sanitizeGains(new Array(40).fill(1)).length === C.BAND_COUNT);

// --- Comparison / formatting ---
check('gainsEqual tolerates float round-tripping',
    C.gainsEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.01]));
check('gainsEqual separates genuinely different curves',
    !C.gainsEqual(C.FLAT, C.BUILTIN_PRESETS[1][1]));
check('gainsEqual rejects a length mismatch',
    !C.gainsEqual([0, 0], C.FLAT));
check('formatDb marks zero plainly', C.formatDb(0) === '0');
check('formatDb signs a boost', C.formatDb(3) === '+3');
check('formatDb signs a cut', C.formatDb(-4.5) === '-4.5');
check('formatDb rounds to a tenth', C.formatDb(2.04) === '+2');

// --- Keys ---
check('every settings key is a non-empty string',
    Object.values(C.Keys).every(k => typeof k === 'string' && k.length > 0));
check('settings keys are unique',
    new Set(Object.values(C.Keys)).size === Object.keys(C.Keys).length);

print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);
