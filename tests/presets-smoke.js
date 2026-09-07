#!/usr/bin/env -S gjs -m
// Headless checks for the preset store. Run: gjs -m tests/presets-smoke.js
import * as C from '../gnomeeq@vanvonvan.github.io/lib/constants.js';
import * as P from '../gnomeeq@vanvonvan.github.io/lib/presets.js';

let failures = 0;
function check(name, cond) {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!cond)
        failures++;
}

// --- Corrupt input must never throw ---
check('empty string parses to no presets', P.parseUserPresets('').length === 0);
check('malformed JSON parses to no presets',
    P.parseUserPresets('{not json').length === 0);
check('a JSON array is rejected', P.parseUserPresets('[1,2,3]').length === 0);
check('null parses to no presets', P.parseUserPresets(null).length === 0);
check('a JSON scalar is rejected', P.parseUserPresets('42').length === 0);

// --- Builtins ---
check('builtins are all present',
    P.allPresets('{}').filter(p => p.builtin).length === C.BUILTIN_PRESETS.length);
check('Flat is recognized as builtin', P.isBuiltin('Flat'));
check('a user name is not builtin', !P.isBuiltin('My Curve'));
check('findPreset locates a builtin',
    P.findPreset('{}', 'Bass Boost')?.gains.length === C.BAND_COUNT);
check('findPreset returns null for the unknown',
    P.findPreset('{}', 'Nope') === null);
check('mutating a returned builtin does not corrupt the table', (() => {
    P.allPresets('{}')[0].gains[0] = 99;
    return C.BUILTIN_PRESETS[0][1][0] === 0;
})());

// --- Saving ---
// Derived from BAND_COUNT, not hardcoded: the band count has changed once
// already and a fixed-length fixture silently fails sanitizeGains padding.
const g = Array.from({ length: C.BAND_COUNT }, (_, i) => i - 5);
const saved = P.addUserPreset('{}', 'My Curve', g);
check('saving succeeds', saved.ok);
check('saved preset is retrievable',
    C.gainsEqual(P.findPreset(saved.json, 'My Curve').gains, g));
check('saved preset is not marked builtin',
    P.findPreset(saved.json, 'My Curve').builtin === false);
check('an empty name is refused', !P.addUserPreset('{}', '   ', g).ok);
check('a builtin name is refused', !P.addUserPreset('{}', 'Flat', g).ok);
check('refusal explains itself',
    typeof P.addUserPreset('{}', 'Flat', g).error === 'string');
check('refusal leaves the store untouched',
    P.addUserPreset(saved.json, 'Flat', g).json === saved.json);
check('a name is trimmed',
    P.findPreset(P.addUserPreset('{}', '  Padded  ', g).json, 'Padded') !== null);
check('re-saving the same name overwrites rather than duplicating', (() => {
    const once = P.addUserPreset('{}', 'Dup', g).json;
    const twice = P.addUserPreset(once, 'Dup', C.FLAT).json;
    return P.parseUserPresets(twice).length === 1 &&
        C.gainsEqual(P.findPreset(twice, 'Dup').gains, C.FLAT);
})());
check('out-of-range gains are clamped on save',
    P.findPreset(P.addUserPreset('{}', 'Wild', new Array(10).fill(999)).json,
        'Wild').gains[0] === C.GAIN_MAX);

// --- Deleting ---
check('deleting removes the preset',
    P.findPreset(P.removeUserPreset(saved.json, 'My Curve'), 'My Curve') === null);
check('deleting the absent is a no-op',
    P.parseUserPresets(P.removeUserPreset(saved.json, 'Ghost')).length === 1);
check('a builtin survives a delete attempt',
    P.findPreset(P.removeUserPreset('{}', 'Flat'), 'Flat') !== null);

// --- Matching (drives the radio dot and the Custom fallback) ---
check('flat gains match Flat', P.matchPreset('{}', C.FLAT) === 'Flat');
check('a builtin curve matches by name',
    P.matchPreset('{}', C.BUILTIN_PRESETS[1][1]) === 'Bass Boost');
check('an unknown curve matches nothing',
    P.matchPreset('{}', [11, -11, 7, -7, 3, -3, 9, -9, 5, -5]) === null);
check('a saved curve matches its own name',
    P.matchPreset(saved.json, g) === 'My Curve');
check('a nudged slider stops matching the preset', (() => {
    const nudged = C.BUILTIN_PRESETS[1][1].slice();
    nudged[4] += 3;
    return P.matchPreset('{}', nudged) === null;
})());

// --- Round trip ---
check('serialize/parse round-trips', (() => {
    const json = P.serializeUserPresets([['A', g], ['B', C.FLAT]]);
    const back = P.parseUserPresets(json);
    return back.length === 2 && C.gainsEqual(back[0][1], g);
})());
check('user presets come back sorted', (() => {
    const json = P.serializeUserPresets([['Zeta', g], ['Alpha', g]]);
    return P.parseUserPresets(json)[0][0] === 'Alpha';
})());

print(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0)
    imports.system.exit(1);
