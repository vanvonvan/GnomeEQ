// Preset storage, kept as pure functions over a JSON string so it can be
// tested headlessly. The caller owns the GSettings round-trip; nothing here
// touches GNOME. User presets live in one JSON object:
//     { "My Curve": [10 gains in dB], ... }

import * as C from './constants.js';

const BUILTIN_NAMES = new Set(C.BUILTIN_PRESETS.map(([n]) => n));

export function isBuiltin(name) {
    return BUILTIN_NAMES.has(name);
}

// Never throw on stored data: a corrupt or hand-edited dconf string must
// degrade to "no user presets" rather than break the whole menu.
export function parseUserPresets(json) {
    let raw;
    try {
        raw = JSON.parse(json || '{}');
    } catch {
        return [];
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return [];
    return Object.keys(raw)
        .filter(name => typeof name === 'string' && name.trim().length > 0)
        .filter(name => !isBuiltin(name))
        .sort((a, b) => a.localeCompare(b))
        .map(name => [name, C.sanitizeGains(raw[name])]);
}

export function serializeUserPresets(list) {
    const obj = {};
    for (const [name, gains] of list)
        obj[name] = C.sanitizeGains(gains);
    return JSON.stringify(obj);
}

// Builtins first (in their curated order), then user presets alphabetically.
// Each entry is { name, gains, builtin }.
export function allPresets(userJson) {
    const out = C.BUILTIN_PRESETS.map(([name, gains]) =>
        ({ name, gains: gains.slice(), builtin: true }));
    for (const [name, gains] of parseUserPresets(userJson))
        out.push({ name, gains, builtin: false });
    return out;
}

export function findPreset(userJson, name) {
    return allPresets(userJson).find(p => p.name === name) ?? null;
}

// Trim to something storable. Returns '' for a name we refuse.
export function normalizeName(name) {
    return typeof name === 'string' ? name.trim().slice(0, 48) : '';
}

// Returns { ok, json, error }. Rejects empty names and builtin collisions —
// shadowing 'Flat' would leave the user unable to get back to flat.
export function addUserPreset(userJson, name, gains) {
    const clean = normalizeName(name);
    if (!clean)
        return { ok: false, json: userJson, error: 'Name cannot be empty.' };
    if (isBuiltin(clean))
        return {
            ok: false,
            json: userJson,
            error: `"${clean}" is a built-in preset name.`,
        };
    const list = parseUserPresets(userJson).filter(([n]) => n !== clean);
    list.push([clean, C.sanitizeGains(gains)]);
    return { ok: true, json: serializeUserPresets(list), error: null };
}

export function removeUserPreset(userJson, name) {
    const list = parseUserPresets(userJson).filter(([n]) => n !== name);
    return serializeUserPresets(list);
}

// Which preset do these gains correspond to, if any? Used to show the right
// radio dot and to fall back to "Custom" after a slider nudge. Builtins win
// ties so the curated name is what gets shown.
export function matchPreset(userJson, gains) {
    const hit = allPresets(userJson).find(p => C.gainsEqual(p.gains, gains));
    return hit ? hit.name : null;
}
