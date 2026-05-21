// Transport-feature app glue. Owns:
//   * the JS-side state needed to wire the WASM transport into the existing
//     audio graph (gain node, mic source, "wired" flag);
//   * all transport-bar / waveform-canvas / hotkey event handlers;
//   * Prefs subscriptions for monitorInput + waveformGain;
//   * the rAF poll that mirrors C++ transport state onto button styling.
//
// Depends on a small "host" interface from App (see app.js's return object):
//   host.getAudioCtx() / getAnalyser() / getAppState()
//   host.audioConstraints()
//   host.ensureAudioCtx()
//   host.startVisualization()
//   host.disconnectMediaSources()

const TransportApp = (() => {
    let host = null;

    let waveInitialized    = false;
    let transportWired     = false;
    let transportGain      = null;
    let transportMicSrc    = null;       // Owned mic source (only when no legacy mic exists)
    let transportMicStream = null;       // Owned MediaStream
    let usingLegacyMic     = false;      // True if we forked the App's existing micSourceNode
    let legacyWasRunning   = false;      // Snapshot of host.getAppState() at wire time
    let teardownGen        = 0;          // Bumped per teardown; pending fades compare before disconnecting

    let lastPolledState    = -1;
    let lastPolledSelected = -2;  // sentinel; -1 is a real value

    function setStatus(text) {
        const el = document.getElementById("transportStatus");
        if (el) el.textContent = text;
    }

    function ensureWaveRenderer() {
        if (waveInitialized) return;
        if (typeof WaveRenderer === "undefined") return;
        const canvas = document.getElementById("transportWaveform");
        if (!canvas) return;
        WaveRenderer.init(canvas, {
            onSeek: (frame) => {
                if (Transport.getState() === Transport.STATE_RECORDING) return;
                playFrom(frame).catch(err => console.error(err));
            }
        });
        waveInitialized = true;
    }

    async function ensureTransportReady() {
        host.ensureAudioCtx();
        if (typeof Transport === "undefined") throw new Error("Transport module not loaded");
        if (!Transport.isReady()) {
            await Transport.init(host.getAudioCtx(), 2);
            // Push persisted display preferences into C++.
            Transport.setDisplayGain(Prefs.get("waveformGain") || 1.0);
        }
        ensureWaveRenderer();
    }

    async function loadTransportFile(file) {
        if (!file) return null;
        await ensureTransportReady();
        const info = await Transport.loadFile(file);
        if (info) setStatus(`Loaded ${info.durationSec.toFixed(1)}s @ ${info.sampleRate}Hz`);
        if (typeof WaveRenderer !== "undefined") WaveRenderer.refresh();
        syncTransportButtons();
        return info;
    }

    function wireTransportGraph() {
        if (transportWired) return;

        // Remember whether the legacy spectrogram was running so we can
        // restore the mic→analyser edge when the transport returns to IDLE.
        legacyWasRunning = (host.getAppState() === "running");

        const audioCtx     = host.getAudioCtx();
        const analyser     = host.getAnalyser();
        const node         = Transport.getNode();
        const legacyMicSrc = host.getMicSourceNode && host.getMicSourceNode();

        // If the App already has a live mic source, fork it instead of
        // tearing it down + re-acquiring. Drop the legacy mic→analyser edge
        // here; the transport will feed the analyser while wired, and we
        // restore the legacy edge on teardown.
        if (legacyMicSrc) {
            usingLegacyMic = true;
            try { legacyMicSrc.disconnect(analyser); } catch (_) {}
        } else {
            usingLegacyMic = false;
        }

        try { node.disconnect(); } catch (_) {}
        node.connect(analyser);

        if (!transportGain) {
            transportGain = audioCtx.createGain();
            transportGain.gain.value = 1;
        } else {
            transportGain.gain.setValueAtTime(1, audioCtx.currentTime);
        }
        try { analyser.disconnect(); } catch (_) {}
        analyser.connect(transportGain);
        transportGain.connect(audioCtx.destination);
        transportWired = true;
    }

    // Tears down the transport-side audio edges and restores the legacy
    // mic→analyser path (if there was one). Fades transportGain to 0 first
    // to avoid an audible click on disconnect.
    function teardownTransportGraph() {
        if (!transportWired) return;
        transportWired = false;  // Guard against re-entry while the fade is pending.
        const myGen   = ++teardownGen;
        const audioCtx = host.getAudioCtx();
        const analyser = host.getAnalyser();
        const node     = Transport.getNode();
        if (!audioCtx) return;

        const FADE_MS = 6;
        if (transportGain) {
            const t0 = audioCtx.currentTime;
            try {
                transportGain.gain.cancelScheduledValues(t0);
                transportGain.gain.setValueAtTime(transportGain.gain.value, t0);
                transportGain.gain.linearRampToValueAtTime(0, t0 + FADE_MS / 1000);
            } catch (_) {}
        }

        // Schedule the actual disconnect just after the ramp completes so
        // the graph is silent at the moment of edge removal. If a new
        // wire/teardown cycle started in the meantime, the generation check
        // bails out so we don't yank edges out of the freshly-wired graph.
        setTimeout(() => {
            if (myGen !== teardownGen) return;
            try { node.disconnect(analyser); } catch (_) {}
            if (transportGain) {
                try { analyser.disconnect(transportGain); } catch (_) {}
                try { transportGain.disconnect();        } catch (_) {}
            }
            if (usingLegacyMic) {
                // Detach mic from transport node and restore mic→analyser.
                const legacyMicSrc = host.getMicSourceNode && host.getMicSourceNode();
                if (legacyMicSrc) {
                    try { legacyMicSrc.disconnect(node); } catch (_) {}
                }
                if (legacyWasRunning && host.reconnectLegacyMicToAnalyser) {
                    host.reconnectLegacyMicToAnalyser();
                }
            } else if (transportMicStream) {
                // Transport-owned mic: free it.
                try { transportMicStream.getTracks().forEach(t => t.stop()); } catch (_) {}
                transportMicStream = null;
                transportMicSrc    = null;
            }
            usingLegacyMic   = false;
            legacyWasRunning = false;
        }, FADE_MS + 2);
    }

    function updateMonitorGain() {
        if (!transportGain) return;
        const audioCtx = host.getAudioCtx();
        if (!audioCtx) return;
        const state     = Transport.getState();
        const monitorOn = !!Prefs.get("monitorInput");
        const audible   = (state !== Transport.STATE_RECORDING) || monitorOn;
        transportGain.gain.setValueAtTime(audible ? 1 : 0, audioCtx.currentTime);
    }

    async function ensureMicConnected() {
        // Prefer the App's existing micSourceNode if it's live; just fork
        // an edge into the transport node. Avoids a second getUserMedia
        // permission prompt and a parallel mic stream.
        const legacyMicSrc = host.getMicSourceNode && host.getMicSourceNode();
        if (legacyMicSrc) {
            try { legacyMicSrc.connect(Transport.getNode()); } catch (_) {}
            return;
        }
        if (transportMicSrc) return;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: host.audioConstraints(),
            video: false
        });
        transportMicStream = stream;
        transportMicSrc    = host.getAudioCtx().createMediaStreamSource(stream);
        transportMicSrc.connect(Transport.getNode());
    }

    async function playFrom(frame) {
        await ensureTransportReady();
        if (Transport.getTrackLength() <= 0) {
            setStatus("Empty track — load a file or hit Record");
            return;
        }
        Transport.setPos(frame | 0);
        wireTransportGraph();
        try { await host.getAudioCtx().resume(); } catch (_) {}
        Transport.play();
        updateMonitorGain();
        if (host.getAppState() !== "running") host.startVisualization();
        syncTransportButtons();
        setStatus("Playing");
    }

    // Play button: state-aware.
    //   IDLE:      play from current pos (rewind to 0 if at end of track)
    //   PLAYING:   restart from 0
    //   RECORDING: switch to playback from current pos (region is finalized)
    async function playButtonClicked() {
        await ensureTransportReady();
        const s = Transport.getState();
        if (s === Transport.STATE_PLAYING) {
            await playFrom(0);
        } else if (s === Transport.STATE_RECORDING) {
            await playFrom(Transport.getPos());
        } else {
            const pos = (Transport.getPos() >= Transport.getTrackLength()) ? 0 : Transport.getPos();
            await playFrom(pos);
        }
    }

    // Rec button: toggle.
    //   IDLE / PLAYING: start a new recording at current pos
    //   RECORDING:      stop record, rewind to that region's trackStart, IDLE
    async function recordButtonClicked() {
        await ensureTransportReady();
        if (Transport.getState() === Transport.STATE_RECORDING) {
            const curId = Transport.getCurrentRegionId();
            let rewindTo = 0;
            if (curId >= 0) {
                const r = Transport.getRegion(curId);
                if (r && r.active) rewindTo = r.trackStartFrame;
            }
            Transport.stop();
            Transport.setPos(rewindTo);
            updateMonitorGain();
            // Tear down directly so the legacy mic→analyser edge is restored
            // immediately rather than after the next poll tick. (The poll
            // loop still catches C++-initiated IDLE transitions.)
            teardownTransportGraph();
            if (typeof WaveRenderer !== "undefined") WaveRenderer.refresh();
            syncTransportButtons();
            setStatus("Stopped (at region start)");
            return;
        }
        wireTransportGraph();
        try { await host.getAudioCtx().resume(); } catch (_) {}
        try {
            await ensureMicConnected();
        } catch (err) {
            setStatus("Mic denied: " + err.message);
            console.error(err);
            return;
        }
        const id = Transport.record();
        if (id < 0) { setStatus("Region table full"); return; }
        updateMonitorGain();
        if (host.getAppState() !== "running") host.startVisualization();
        if (typeof WaveRenderer !== "undefined") WaveRenderer.refresh();
        syncTransportButtons();
        setStatus("Recording…");
    }

    function stopButtonClicked() {
        if (typeof Transport === "undefined" || !Transport.isReady()) return;
        const wasPlaying = Transport.getState() === Transport.STATE_PLAYING;
        Transport.stop();
        // Second press (or press while recording / already idle) rewinds.
        if (!wasPlaying) Transport.setPos(0);
        updateMonitorGain();
        teardownTransportGraph();
        if (typeof WaveRenderer !== "undefined") WaveRenderer.refresh();
        syncTransportButtons();
        setStatus(wasPlaying ? "Stopped" : "Stopped (rewound)");
    }

    function deleteSelectedRegion() {
        if (typeof Transport === 'undefined' || !Transport.isReady()) return;
        const sel = Transport.getSelectedRegion();
        if (sel < 0) return;
        Transport.deactivateRegion(sel);
        if (typeof WaveRenderer !== 'undefined') WaveRenderer.refresh();
        syncTransportButtons();
    }

    function syncTransportButtons() {
        if (typeof Transport === "undefined" || !Transport.isReady()) return;
        const state     = Transport.getState();
        const playing   = state === Transport.STATE_PLAYING;
        const recording = state === Transport.STATE_RECORDING;
        const idle      = state === Transport.STATE_IDLE;
        const hasTrack  = Transport.getTrackLength() > 0;

        const playBtn   = document.getElementById("transportPlayBtn");
        const recBtn    = document.getElementById("transportRecordBtn");
        const stopBtn   = document.getElementById("transportStopBtn");
        const deleteBtn = document.getElementById("transportDeleteBtn");
        const loopBtn   = document.getElementById("transportLoopBtn");

        if (playBtn) {
            playBtn.disabled = !hasTrack;
            playBtn.classList.toggle("btn-success", playing);
            playBtn.classList.toggle("btn-outline-success", !playing);
        }
        if (recBtn) {
            recBtn.classList.toggle("btn-danger", recording);
            recBtn.classList.toggle("btn-outline-danger", !recording);
            recBtn.textContent = recording ? "■ Stop Rec" : "● Rec";
        }
        if (stopBtn) {
            // Always enabled: when idle, Stop rewinds to 0.
            stopBtn.disabled = false;
            stopBtn.classList.toggle("btn-light", !idle);
            stopBtn.classList.toggle("btn-outline-light", idle);
        }
        if (deleteBtn) {
            deleteBtn.disabled = Transport.getSelectedRegion() < 0;
        }
        if (loopBtn) {
            const looping = Transport.getLoopEnabled() === 1;
            loopBtn.classList.toggle("btn-info", looping);
            loopBtn.classList.toggle("btn-outline-info", !looping);
        }
    }

    function pollTransportState() {
        if (typeof Transport !== "undefined" && Transport.isReady()) {
            const s   = Transport.getState();
            const sel = Transport.getSelectedRegion();
            if (s !== lastPolledState || sel !== lastPolledSelected) {
                // Safety net for C++-initiated IDLE transitions (e.g. auto-stop
                // at end of track). Button handlers tear down synchronously.
                if (s === Transport.STATE_IDLE
                    && lastPolledState !== Transport.STATE_IDLE
                    && transportWired)
                {
                    teardownTransportGraph();
                }
                lastPolledState    = s;
                lastPolledSelected = sel;
                syncTransportButtons();
            }
        }
        requestAnimationFrame(pollTransportState);
    }

    function wireUI() {
        const surfaceErr = (err) => { setStatus("Error: " + err.message); console.error(err); };

        const tLoadBtn = document.getElementById("transportLoadBtn");
        const tFileInp = document.getElementById("transportFileInput");
        if (tLoadBtn && tFileInp) {
            tLoadBtn.addEventListener('click', () => tFileInp.click());
            tFileInp.addEventListener('change', e => {
                loadTransportFile(e.target.files[0]).catch(surfaceErr);
            });
        }

        const byId = (id) => document.getElementById(id);
        const tPlayBtn   = byId("transportPlayBtn");
        const tRecBtn    = byId("transportRecordBtn");
        const tStopBtn   = byId("transportStopBtn");
        const tDeleteBtn = byId("transportDeleteBtn");
        const tLoopBtn   = byId("transportLoopBtn");
        if (tPlayBtn)   tPlayBtn  .addEventListener('click', () => playButtonClicked()  .catch(surfaceErr));
        if (tRecBtn)    tRecBtn   .addEventListener('click', () => recordButtonClicked().catch(surfaceErr));
        if (tStopBtn)   tStopBtn  .addEventListener('click', stopButtonClicked);
        if (tDeleteBtn) tDeleteBtn.addEventListener('click', deleteSelectedRegion);
        if (tLoopBtn)   tLoopBtn  .addEventListener('click', () => {
            if (typeof Transport === "undefined" || !Transport.isReady()) return;
            Transport.setLoopEnabled(!Transport.getLoopEnabled());
            syncTransportButtons();
        });

        const adjustZoom = (factor) => {
            host.ensureAudioCtx();
            if (typeof Transport === "undefined" || !Transport.isReady()) return;
            Transport.setDisplayZoom((Transport.getDisplayZoom() || 1) * factor);
        };
        const zoomInBtn  = byId("transportZoomInBtn");
        const zoomOutBtn = byId("transportZoomOutBtn");
        if (zoomInBtn)  zoomInBtn .addEventListener('click', () => adjustZoom(2));
        if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => adjustZoom(0.5));

        const helpBtn = byId("transportHelpBtn");
        if (helpBtn && typeof bootstrap !== "undefined" && bootstrap.Popover) {
            // sanitize:false because the popover content is hard-coded HTML in
            // index.html (we want <kbd> rendered) — no user input flows in.
            new bootstrap.Popover(helpBtn, { sanitize: false });
        }

        // Global hotkeys. Skipped while focus is in a form control so we
        // don't eat the user's keystrokes there.
        document.addEventListener('keydown', (e) => {
            const t   = e.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
            if (typeof Transport === 'undefined') return;
            // Don't shadow browser shortcuts like Ctrl+R, Cmd+L, etc.
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            const key = e.key;
            const isSpace = key === ' ' || e.code === 'Space';
            const isT     = key === 't' || key === 'T';
            const isDel   = key === 'Delete' || key === 'Backspace';
            const isEnter = key === 'Enter';

            if (isDel) {
                if (!Transport.isReady() || Transport.getSelectedRegion() < 0) return;
                e.preventDefault();
                deleteSelectedRegion();
                return;
            }
            if (isSpace) {
                e.preventDefault();
                const s = Transport.isReady() ? Transport.getState() : 0;
                if (s === Transport.STATE_PLAYING) stopButtonClicked();
                else                               playButtonClicked().catch(err => console.error(err));
                return;
            }
            if (isT) {
                e.preventDefault();
                recordButtonClicked().catch(err => console.error(err));
                return;
            }
            if (isEnter) {
                if (!Transport.isReady()) return;
                e.preventDefault();
                Transport.setPos(0);
                return;
            }
        });
    }

    function registerPrefs() {
        if (typeof Prefs === "undefined") return;
        Prefs.onChange((key, value) => {
            if (key === "monitorInput") {
                updateMonitorGain();
            } else if (key === "waveformGain") {
                if (typeof Transport !== "undefined" && Transport.isReady()) {
                    Transport.setDisplayGain(value || 1.0);
                }
                if (typeof WaveRenderer !== "undefined") WaveRenderer.refresh();
            }
        });
    }

    function init(hostApi) {
        host = hostApi;
        wireUI();
        registerPrefs();
        requestAnimationFrame(pollTransportState);
    }

    return { init };
})();

window.addEventListener('DOMContentLoaded', () => TransportApp.init(App));
