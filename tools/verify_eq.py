#!/usr/bin/env python3
"""Verify the GnomeEQ filter-chain sink by MEASURING it, not by trusting it.

Why this exists: `pw-cli set-param ... Props` reports success and `pw-dump`
reads back a template of zeros regardless of the live values, so neither one
tells you whether a gain actually took effect. The only trustworthy check is
to push audio through the sink and look at the spectrum.

Method: create a null sink, re-link the EQ's output into it (so nothing is
audible), play a multi-tone probe into the EQ sink, record the null sink's
monitor, and do a single-bin DFT at each band centre. Compare against a flat
reference. Restores the original routing on exit.

Note on pw-record: WirePlumber's policy overrides `--target`, happily
connecting the recorder to the (muted) microphone and yielding pure silence.
`--target=0` disables autoconnect so the links can be made explicitly.

Run: python3 tools/verify_eq.py          (or `make verify`)
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

SINK = "effect_input.gnomeeq"
OUT = "effect_output.gnomeeq"
NULL = "gnomeeq_verify"
SR = 48000
TONE_AMP = 0.055


def band_freqs():
    """Read the band centres out of the generated chain config.

    Deliberately not a second copy of the table: this harness must measure the
    filters that are actually installed, so it asks the config rather than
    trusting a constant that could have drifted.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    conf = os.path.join(os.path.dirname(here),
                        "gnomeeq@vanvonvan.github.io", "data",
                        "gnomeeq-sink.conf")
    with open(conf) as fh:
        freqs = [float(m) for m in
                 re.findall(r'"Freq"\s*=\s*([0-9.]+)', fh.read())]
    if not freqs:
        sys.exit(f"no band frequencies found in {conf}")
    return freqs


BANDS = band_freqs()


def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def pw_dump():
    return json.loads(sh("pw-dump").stdout or "[]")


def node_id(name):
    for o in pw_dump():
        props = (o.get("info", {}) or {}).get("props", {}) or {}
        if props.get("node.name") == name:
            return o["id"]
    return None


def make_probe(path):
    t = np.arange(int(SR * 4.0)) / SR
    sig = sum(TONE_AMP * np.sin(2 * np.pi * f * t + i)
              for i, f in enumerate(BANDS))
    data = (np.clip(np.stack([sig, sig], axis=1), -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def set_params(nid, pairs):
    args = " ".join(f'"{k}" {v}' for k, v in pairs)
    sh("pw-cli", "set-param", str(nid), "Props", f"{{ params = [ {args} ] }}")
    time.sleep(0.35)


def physical_links():
    """Current links from the EQ output, as (src_port, dst_port) pairs."""
    out, cur = [], None
    for line in sh("pw-link", "-l").stdout.splitlines():
        if not line.startswith((" ", "\t")):
            cur = line.strip()
        elif cur and cur.startswith(f"{OUT}:") and "|->" in line:
            out.append((cur, line.split("|->")[1].strip()))
    return out


def record_through(probe, dest):
    """Play the probe into the EQ sink, capture the null sink's monitor."""
    rec = subprocess.Popen(["pw-record", "--target=0", dest],
                           stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
    time.sleep(0.55)
    for ch in ("FL", "FR"):
        sh("pw-link", f"{NULL}:monitor_{ch}", f"pw-record:input_{ch}")
    time.sleep(0.25)
    sh("pw-play", f"--target={SINK}", probe)
    time.sleep(0.35)
    rec.terminate()
    rec.wait(timeout=5)


def levels(path):
    with wave.open(path, "rb") as w:
        ch, sr = w.getnchannels(), w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()),
                          dtype="<i2").astype(float) / 32768.0
    x = x.reshape(-1, ch)[:, 0]
    nz = np.nonzero(np.abs(x) > 1e-4)[0]
    if len(nz) < sr:
        return None
    x = x[nz[0]:nz[-1]]
    k = int(0.4 * sr)
    if len(x) > 2 * k + sr:
        x = x[k:-k]
    n = len(x)
    win = np.hanning(n)
    xw, t = x * win, np.arange(n) / sr
    return {f: 20 * np.log10(max(
        abs(np.sum(xw * np.exp(-2j * np.pi * f * t))) / np.sum(win) * 2, 1e-12))
        for f in BANDS}


def main():
    nid = node_id(SINK)
    if nid is None:
        sys.exit(f"{SINK} not found — is filter-chain.service running with "
                 "the GnomeEQ config installed?")
    print(f"EQ sink node id: {nid}")

    saved = physical_links()
    tmp = tempfile.mkdtemp(prefix="gnomeeq-verify-")
    probe = os.path.join(tmp, "probe.wav")
    make_probe(probe)
    # Derived from the band table, never hardcoded: an earlier version fixed
    # this at ten and silently skipped band 11 when the grid grew, reporting a
    # perfectly good filter as +0.00 dB.
    flat_pairs = [(f"eq_band_{i}:Gain", 0.0)
                  for i in range(1, len(BANDS) + 1)]
    failures = []

    sh("pw-cli", "create-node", "adapter",
       f"{{ factory.name=support.null-audio-sink node.name={NULL} "
       f"media.class=Audio/Sink object.linger=true audio.position=[FL,FR] }}")
    time.sleep(1.0)
    try:
        for src, dst in saved:
            sh("pw-link", "-d", src, dst)
        for ch in ("FL", "FR"):
            sh("pw-link", f"{OUT}:output_{ch}", f"{NULL}:playback_{ch}")
        time.sleep(0.4)

        set_params(nid, flat_pairs + [("preamp:Mult", 1.0)])
        ref = os.path.join(tmp, "flat.wav")
        record_through(probe, ref)
        flat = levels(ref)
        if flat is None:
            sys.exit("no signal captured — cannot verify")

        print("\nPer-band response, each band set to +12 dB alone:")
        print(f"{'band':>4} {'freq':>10} {'own gain':>10} {'verdict':>8}")
        for i, f in enumerate(BANDS, start=1):
            pairs = [(f"eq_band_{j}:Gain", 12.0 if j == i else 0.0)
                     for j in range(1, len(BANDS) + 1)]
            path = os.path.join(tmp, f"b{i}.wav")
            set_params(nid, pairs)
            record_through(probe, path)
            lv = levels(path)
            if lv is None:
                print(f"{i:>4} {f:>9.1f}Hz   NO SIGNAL")
                failures.append(f"band {i}: no signal")
                continue
            own = lv[f] - flat[f]
            ok = 10.0 < own < 13.5
            print(f"{i:>4} {f:>9.1f}Hz {own:>+9.2f} {'ok' if ok else 'FAIL':>8}")
            if not ok:
                failures.append(f"band {i} ({f} Hz): {own:+.2f} dB, want +12")

        print("\nPreamp, set to -6 dB (Mult=0.5012) with bands flat:")
        set_params(nid, flat_pairs + [("preamp:Mult", 0.5012)])
        path = os.path.join(tmp, "preamp.wav")
        record_through(probe, path)
        lv = levels(path)
        if lv is None:
            failures.append("preamp: no signal")
            print("  NO SIGNAL")
        else:
            deltas = [lv[f] - flat[f] for f in BANDS]
            avg = float(np.mean(deltas))
            spread = float(np.max(deltas) - np.min(deltas))
            ok = abs(avg + 6.0) < 1.0 and spread < 1.0
            print(f"  mean shift {avg:+.2f} dB across all bands "
                  f"(spread {spread:.2f} dB)  {'ok' if ok else 'FAIL'}")
            if not ok:
                failures.append(f"preamp: {avg:+.2f} dB mean, want -6.00")
    finally:
        set_params(nid, flat_pairs + [("preamp:Mult", 1.0)])
        sh("pw-cli", "destroy", NULL)
        time.sleep(0.5)
        subprocess.run(["systemctl", "--user", "restart",
                        "filter-chain.service"])
        time.sleep(1.5)

    print()
    if failures:
        print("FAILURES:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS — every band and the preamp verified by measurement.")


if __name__ == "__main__":
    main()
