// The bridge between the extension and the PipeWire graph.
//
// There is no GObject-introspected API for filter-chain parameters, so this
// drives the CLI tools (`pw-dump`, `pw-cli`, `wpctl`, `pw-metadata`) through
// Gio.Subprocess. All of it is async: the Shell runs the compositor on this
// thread, and a synchronous spawn would stutter the whole desktop.
//
// Two facts about this interface, both established by measurement, shape the
// code below:
//
//   * Band gains ARE settable live. `pw-cli set-param <id> Props` applies
//     immediately with no restart and no audio gap, which is what makes
//     preset switching instant.
//   * Reading them back is NOT possible. `pw-dump` reports a template of
//     zeros for the graph controls regardless of the live values (it even
//     reports Freq as 0 when the config sets 31 Hz). So GSettings is the
//     single source of truth for what the EQ is set to; we only ever write
//     to the graph, never read from it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as C from './constants.js';

// Coalesce slider drags. A drag emits a change per pixel; without this we
// would spawn a process per pixel.
const APPLY_DEBOUNCE_MS = 40;

// systemd reports filter-chain.service active as soon as the process is
// spawned, but its nodes reach the graph a moment later, so a single pw-dump
// straight after a start reliably misses the sink. Poll for it instead.
const SINK_POLL_MS = 250;
const SINK_POLL_TRIES = 20;

function runAsync(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (p.get_successful())
                    resolve(stdout ?? '');
                else
                    reject(new Error((stderr || '').trim() || `${argv[0]} failed`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class PipeWireEQ {
    constructor(extensionPath) {
        this._path = extensionPath;
        this._cancellable = new Gio.Cancellable();
        this._sinkId = null;
        this._outputId = null;
        this._applyTimer = 0;
        this._waitTimers = new Map();
        this._pending = null;
        this._busy = false;
        this._destroyed = false;
    }

    destroy() {
        this._destroyed = true;
        if (this._applyTimer) {
            GLib.Source.remove(this._applyTimer);
            this._applyTimer = 0;
        }
        // Resolve the sleeps as we cancel them, so anything awaiting one
        // continues and sees _destroyed rather than hanging forever.
        for (const [id, resolve] of this._waitTimers) {
            GLib.Source.remove(id);
            resolve();
        }
        this._waitTimers.clear();
        this._cancellable.cancel();
        this._pending = null;
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._waitTimers.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._waitTimers.set(id, resolve);
        });
    }

    // --- Engine setup -----------------------------------------------------

    get _confDir() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), C.CONF_SUBDIR]);
    }

    get _confPath() {
        return GLib.build_filenamev([this._confDir, C.CONF_NAME]);
    }

    get _shippedConfPath() {
        return GLib.build_filenamev([this._path, 'data', 'gnomeeq-sink.conf']);
    }

    _readFile(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return null;
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    }

    // Is the installed chain config byte-identical to the one we ship? If it
    // is missing or stale the sink either does not exist or has the wrong band
    // layout, and the filter-chain daemon has to be restarted to pick it up.
    confNeedsInstall() {
        const shipped = this._readFile(this._shippedConfPath);
        if (shipped === null)
            return false; // nothing to install; report no work rather than lie
        return this._readFile(this._confPath) !== shipped;
    }

    // Install the chain config and restart the daemon that serves it.
    // Restarting briefly interrupts audio and renumbers the nodes, so this
    // runs only when confNeedsInstall() says it must.
    async installEngine() {
        const shipped = this._readFile(this._shippedConfPath);
        if (shipped === null)
            throw new Error('GnomeEQ is missing its bundled sink config.');
        GLib.mkdir_with_parents(this._confDir, 0o755);
        if (!GLib.file_set_contents(this._confPath, shipped))
            throw new Error(`Could not write ${this._confPath}`);
        await runAsync(['systemctl', '--user', 'restart', C.CONF_SERVICE],
            this._cancellable);
        this._sinkId = null;
        this._outputId = null;
    }

    // Start the daemon that serves the chain, without disturbing it if it is
    // already up.
    async startService() {
        await runAsync(['systemctl', '--user', 'start', C.CONF_SERVICE],
            this._cancellable);
        this._sinkId = null;
        this._outputId = null;
    }

    // Make sure the chain is both installed AND actually running, and resolve
    // true once its sink is really in the graph.
    //
    // The daemon cannot be assumed up. filter-chain.service is
    // BindsTo=pipewire.service, so anything that stops PipeWire — a resume, a
    // package upgrade, `systemctl --user restart pipewire` — stops the chain
    // too, and nothing brings it back: the stop is clean, so Restart=on-failure
    // never fires, and BindsTo propagates stops but not starts. Meanwhile the
    // configured default sink still names our sink, so WirePlumber quietly
    // falls back to the hardware and the equalizer is simply out of the path
    // with no error anywhere. Starting the service whenever the sink is missing
    // is what makes the EQ survive that.
    async ensureEngine() {
        if (this.confNeedsInstall())
            await this.installEngine(); // writes the conf and restarts
        else if (await this._resolveNodes(true))
            return true; // already running; do not interrupt audio
        else
            await this.startService();
        return this._waitForSink();
    }

    async _waitForSink() {
        for (let i = 0; i < SINK_POLL_TRIES; i++) {
            if (this._destroyed)
                return false;
            if (await this._resolveNodes(true))
                return true;
            await this._sleep(SINK_POLL_MS);
        }
        return false;
    }

    // --- Node discovery ---------------------------------------------------

    // pw-dump is the only reliable way to map a node name to the numeric id
    // that pw-cli needs. Cached, because the ids only change when the
    // filter-chain daemon restarts.
    async _resolveNodes(force = false) {
        if (!force && this._sinkId !== null)
            return true;
        let objects;
        try {
            objects = JSON.parse(await runAsync(['pw-dump'], this._cancellable));
        } catch {
            return false;
        }
        this._sinkId = null;
        this._outputId = null;
        for (const obj of objects) {
            const props = obj?.info?.props;
            if (!props)
                continue;
            if (props['node.name'] === C.SINK_NODE)
                this._sinkId = obj.id;
            else if (props['node.name'] === C.OUTPUT_NODE)
                this._outputId = obj.id;
        }
        return this._sinkId !== null;
    }

    async isEngineRunning() {
        return this._resolveNodes(true);
    }

    // --- Applying gains ---------------------------------------------------

    // Request that the graph be set to these gains. Safe to call as fast as a
    // slider emits: calls coalesce and never overlap.
    apply(gains, preampDb) {
        if (this._destroyed)
            return;
        this._pending = { gains: gains.slice(), preampDb };
        if (this._applyTimer)
            return;
        this._applyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            APPLY_DEBOUNCE_MS, () => {
                this._applyTimer = 0;
                this._flush();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _flush() {
        if (this._destroyed || this._busy || !this._pending)
            return;
        const job = this._pending;
        this._pending = null;
        this._busy = true;
        try {
            await this._setParams(job.gains, job.preampDb);
        } catch {
            // A stale node id is the expected failure (the filter-chain daemon
            // restarted and renumbered everything). Re-resolve once and retry;
            // if that also fails the engine is genuinely absent, and opening
            // the menu is what puts it back (see the extension's
            // recoverEngine).
            try {
                if (await this._resolveNodes(true))
                    await this._setParams(job.gains, job.preampDb);
            } catch {
                // fall through; nothing useful to do from here
            }
        } finally {
            this._busy = false;
            // A change that arrived while we were busy still needs applying,
            // otherwise the graph ends up behind the sliders.
            if (this._pending && !this._destroyed)
                this._flush();
        }
    }

    async _setParams(gains, preampDb) {
        if (!await this._resolveNodes())
            throw new Error('GnomeEQ sink not found');
        const parts = gains.map((g, i) =>
            `"eq_band_${i + 1}:Gain" ${g.toFixed(2)}`);
        parts.push(`"preamp:Mult" ${C.dbToMult(preampDb).toFixed(6)}`);
        await runAsync(['pw-cli', 'set-param', String(this._sinkId), 'Props',
            `{ params = [ ${parts.join(' ')} ] }`], this._cancellable);
    }

    // --- Routing ----------------------------------------------------------

    // Apps follow the default sink, so claiming it is what makes the
    // equalizer apply to everything without touching any app's settings.
    async claimDefaultSink() {
        if (!await this._resolveNodes(true))
            throw new Error('GnomeEQ sink not found');
        await runAsync(['wpctl', 'set-default', String(this._sinkId)],
            this._cancellable);
    }

    // Is our sink the one apps will actually land on?
    //
    // Deliberately NOT read from "Default Configured Devices": that section
    // reports the stored *preference*, which goes on naming our sink even when
    // the sink does not exist — precisely the case where we most need to hear
    // that audio is not going through the EQ. The `*` markers in the live
    // listing are the effective defaults, so match our node id against those.
    async isDefaultSink() {
        if (!await this._resolveNodes(true))
            return false;
        try {
            const out = await runAsync(['wpctl', 'status'], this._cancellable);
            const marked = [...out.matchAll(/\*\s+(\d+)\./g)]
                .map(m => Number(m[1]));
            return marked.includes(this._sinkId);
        } catch {
            return false;
        }
    }

    // Physical sinks the chain could feed — everything except our own two
    // nodes and any other virtual effect sink.
    async listOutputDevices() {
        let objects;
        try {
            objects = JSON.parse(await runAsync(['pw-dump'], this._cancellable));
        } catch {
            return [];
        }
        const out = [];
        for (const obj of objects) {
            const props = obj?.info?.props;
            if (!props || props['media.class'] !== 'Audio/Sink')
                continue;
            const name = props['node.name'] ?? '';
            if (name === C.SINK_NODE || name.startsWith('effect_'))
                continue;
            out.push({
                id: obj.id,
                name,
                description: props['node.description'] ?? name,
            });
        }
        return out;
    }

    // Pin the chain's output to one device. Without this, choosing a
    // different output in GNOME's own menu would make that device the default
    // and bypass the equalizer entirely; the indicator instead sends the
    // choice here and keeps the EQ sink as the default.
    async setOutputDevice(nodeName) {
        if (!await this._resolveNodes())
            throw new Error('GnomeEQ sink not found');
        if (this._outputId === null)
            throw new Error('GnomeEQ output node not found');
        const value = nodeName || 'null';
        await runAsync(['pw-metadata', String(this._outputId), 'target.object',
            value], this._cancellable);
    }

    // Which device is the chain feeding right now?
    async currentOutputDevice() {
        try {
            const out = await runAsync(['pw-link', '-l'], this._cancellable);
            const lines = out.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith(`${C.OUTPUT_NODE}:output_`))
                    continue;
                const next = lines[i + 1] ?? '';
                const m = next.match(/\|->\s*(\S+?):/);
                if (m)
                    return m[1];
            }
        } catch {
            // fall through
        }
        return null;
    }
}
