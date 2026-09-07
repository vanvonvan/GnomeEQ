// Shared constants for GnomeEQ. Pure data and pure functions — no GNOME
// imports, so tests/ can exercise this file with a plain `gjs` run.

// The eleven bands, low to high. These frequencies must match
// tools/gen_sink_conf.py, which generates the PipeWire filter chain: band N
// here is `eq_band_${N+1}` in the graph. `make test` enforces that agreement —
// if the two drift, a slider labels one frequency and adjusts another.
//
// This is the ISO 266 one-octave series, phase 0: the whole audible range,
// 20 Hz to 20 kHz, on the round preferred values that real hardware uses.
// 315/630/1250 are ISO's rounded forms of 320/640/1280; the worst step is
// 27 cents shy of a true octave, which is inaudible for filters this broad.
// Q = 1.414 is the classic one-octave value and matches this spacing to
// within 0.36% (see gen_sink_conf.py).
//
// Every band is a *peaking* filter, deliberately. A shelf sits at only half
// its set gain at its own corner frequency — measured on this box, a lowshelf
// at 31 Hz with Gain=+15 gave +7.5 dB at 31 Hz and +14.9 dB at 8 Hz. Shelves
// at the extremes would make the end sliders feel dead while spending headroom
// on content nobody can hear.
export const BANDS = [
    { freq: 20, label: '20' },
    { freq: 40, label: '40' },
    { freq: 80, label: '80' },
    { freq: 160, label: '160' },
    { freq: 315, label: '315' },
    { freq: 630, label: '630' },
    { freq: 1250, label: '1.25k' },
    { freq: 2500, label: '2.5k' },
    { freq: 5000, label: '5k' },
    { freq: 10000, label: '10k' },
    { freq: 20000, label: '20k' },
];

export const BAND_COUNT = BANDS.length;

// Perceptual frequency ranges, used to tint each slider row so the spectrum
// is readable at a glance. Boundaries are the conventional ones; `until` is
// exclusive, so a band sitting exactly on a boundary belongs to the range
// above it (2 kHz is upper-mids, not midrange).
//
// Colour runs warm-to-cool with rising frequency: that is both how the visible
// spectrum runs and how people already talk about sound — "warm" bass, "bright"
// treble. The stylesheet applies each `css` class at low alpha so the tint
// reads on the light and the dark shell theme alike (St CSS has no media
// queries, so one value has to serve both).
export const GROUPS = [
    { key: 'subbass',   name: 'Sub-bass',    until: 60,       css: 'gnomeeq-group-subbass' },
    { key: 'bass',      name: 'Bass',        until: 250,      css: 'gnomeeq-group-bass' },
    { key: 'lowermids', name: 'Lower mids',  until: 500,      css: 'gnomeeq-group-lowermids' },
    { key: 'midrange',  name: 'Midrange',    until: 2000,     css: 'gnomeeq-group-midrange' },
    { key: 'uppermids', name: 'Upper mids',  until: 4000,     css: 'gnomeeq-group-uppermids' },
    { key: 'treble',    name: 'Treble',      until: Infinity, css: 'gnomeeq-group-treble' },
];

// Which range does this frequency fall in? Derived rather than stored on each
// band so the boundaries have exactly one definition.
export function groupFor(freq) {
    return GROUPS.find(g => freq < g.until) ?? GROUPS[GROUPS.length - 1];
}

// UI gain range in dB. The filter itself accepts -120..+20, but ±12 is the
// graphic-EQ convention and keeps a slider's travel meaningful.
export const GAIN_MIN = -12;
export const GAIN_MAX = 12;

// Preamp range in dB. Mostly used to cut, to make room for band boosts.
export const PREAMP_MIN = -24;
export const PREAMP_MAX = 6;

// PipeWire node names, set by the generated filter-chain config.
export const SINK_NODE = 'effect_input.gnomeeq';
export const OUTPUT_NODE = 'effect_output.gnomeeq';

// Where the generated chain config has to live for filter-chain.service to
// read it, and the unit that serves it.
export const CONF_SUBDIR = 'pipewire/filter-chain.conf.d';
export const CONF_NAME = '99-gnomeeq-sink.conf';
export const CONF_SERVICE = 'filter-chain.service';

// GSettings keys, in one place so extension.js and prefs.js cannot disagree.
export const Keys = {
    GAINS: 'band-gains',
    PREAMP: 'preamp',
    AUTO_PREAMP: 'auto-preamp',
    ENABLED: 'eq-enabled',
    PRESET: 'current-preset',
    USER_PRESETS: 'user-presets',
    CLAIM_SINK: 'claim-default-sink',
    OUTPUT_DEVICE: 'output-device',
    SHOW_SLIDERS: 'show-band-sliders',
};

// Shipped presets. Order is the menu order; 'Flat' first and always present.
// Values are dB per band, low to high.
export const BUILTIN_PRESETS = [
    //                 20  40  80 160 315 630 1k25 2k5  5k 10k 20k
    ['Flat',          [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0]],
    ['Bass Boost',    [ 6,  6,  5,  3,  1,  0,  0,  0,  0,  0,  0]],
    ['Treble Boost',  [ 0,  0,  0,  0,  0,  0,  1,  2,  4,  5,  5]],
    ['Vocal Clarity', [-4, -3, -2,  0,  2,  3,  3,  3,  1,  0, -1]],
    ['Loudness',      [ 6,  5,  3,  1, -1, -2, -1,  1,  3,  5,  6]],
    ['Rock',          [ 4,  4,  3,  1, -1, -1,  1,  3,  4,  4,  3]],
    ['Electronic',    [ 6,  5,  3,  0, -1,  0,  1,  2,  4,  5,  5]],
    ['Classical',     [ 3,  3,  2,  0,  0,  0, -1, -1,  0,  2,  3]],
    ['Podcast',       [-6, -5, -2,  1,  3,  4,  4,  3,  1, -1, -2]],
    ['Gaming',        [ 4,  4,  2,  0,  0,  1,  3,  4,  4,  2,  1]],
];

// Name shown when the gains match no preset.
export const CUSTOM_LABEL = 'Custom';

export const FLAT = new Array(BAND_COUNT).fill(0);

export function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// The filter chain's preamp is a `linear` node taking a plain multiplier.
export function dbToMult(db) {
    return Math.pow(10, db / 20);
}

// Cancel the biggest boost so a boosted preset cannot clip. Cuts never need
// headroom, hence the max(0, ...).
export function autoPreampFor(gains) {
    const peak = Math.max(0, ...gains);
    return clamp(-peak, PREAMP_MIN, PREAMP_MAX);
}

// Normalize whatever GSettings/JSON handed us into exactly BAND_COUNT
// in-range numbers, so a hand-edited dconf value or an imported preset can
// never desynchronize the sliders from the filter graph.
export function sanitizeGains(raw) {
    const out = FLAT.slice();
    if (!Array.isArray(raw))
        return out;
    for (let i = 0; i < BAND_COUNT; i++) {
        const v = Number(raw[i]);
        out[i] = Number.isFinite(v) ? clamp(v, GAIN_MIN, GAIN_MAX) : 0;
    }
    return out;
}

export function gainsEqual(a, b) {
    if (!a || !b || a.length !== b.length)
        return false;
    // A tenth of a dB is far below audibility; treat closer than that as equal
    // so float round-tripping through GSettings/JSON does not read as "Custom".
    return a.every((v, i) => Math.abs(v - b[i]) < 0.05);
}

export function formatDb(db) {
    const r = Math.round(db * 10) / 10;
    if (Math.abs(r) < 0.05)
        return '0';
    return `${r > 0 ? '+' : ''}${r.toFixed(1).replace(/\.0$/, '')}`;
}
