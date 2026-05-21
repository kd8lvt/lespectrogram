// Main spectrogram app: audio capture, draw loop, hookup to prefs/UI/modules.
const App = (() => {
    let audioCtx = null;
    let mediaStream = null;
    let analyser = null;
    let appState = "stopped";
    let animFrameId = null;

    let wf = null;
    let currentColor = null;
    let frqBuf = null;
    let mappedBuf = null;
    let wfBufAry = null;
    let numBins = 0;
    let pxPerLine = 0;       // canvas vertical pixels (frequency axis)
    let timeColumns = 0;     // canvas horizontal pixels (time axis)
    let currentScale = null;
    let scaleMap = null;
    let resizeTimer = null;

    let fileSourceNode = null;
    let micSourceNode = null;
    let overlayCanvas = null;
    let overlayCtx = null;

    let lastNoteUpdateTs = 0;

    const DATA_RATE = 60; // Fixed number of columns plotted per second
    const DATA_FRAME_MS = 1000 / DATA_RATE;
    let nextDataTickTs = 0;

    const getScale = () => Prefs.get("scaleType");
    const getColor = () => Prefs.get("colorType");
    const getDirection = () => Prefs.get("direction") || "right";
    const getTimeFlip = ()=> Prefs.get("timeFlip") || false;

    function postSync(type, payload = {}) {
        if (typeof Sync !== "undefined") {
            Sync.post(type, payload);
        }
    }

    function computeDisplaySize() {
        const minW = 480, minH = 240;
        const maxW = 4096, maxH = 2048;

        if (!Prefs.get("autoFit")) return { w: 1600, h: 600 };

        const axisLeft = Axes.FREQ_AXIS_W + 12;
        const horizMargin = 32;
        const reservedV = 360;

        const w = Math.max(minW, Math.min(maxW, Math.floor(window.innerWidth - axisLeft - horizMargin)));
        const h = Math.max(minH, Math.min(maxH, Math.floor(window.innerHeight - reservedV)));
        return { w, h };
    }

    function buildAudioBuffers() {
        numBins = analyser.frequencyBinCount;
        const { w, h } = computeDisplaySize();
        pxPerLine = h;
        timeColumns = w;
        frqBuf = new Uint8Array(numBins);
        mappedBuf = new Uint8Array(pxPerLine);
        wfBufAry = { buffer: mappedBuf };
    }

    function drawAxesOverlay() {
        if (!overlayCanvas || !overlayCtx) return;
        Axes.draw(overlayCtx, overlayCanvas.width, overlayCanvas.height, {
            sampleRate: audioCtx ? audioCtx.sampleRate : 48000,
            scale: getScale(),
            timeColumns,
            direction: getDirection(),
            timeFlip: getTimeFlip(),
            columnsPerSecond: Prefs.get('renderMode') === 'frame' ? actualFPS : DATA_RATE,
            showNoteGrid: Prefs.get('showNoteGrid'),
            noteGridColor: Prefs.get('noteGridColor'),
            noteGridOpacity: Prefs.get('noteGridOpacity'),
            noteGridCOpacity: Prefs.get('noteGridCOpacity')
        });
    }

    function createWaterfall() {
        if (wf) wf.stop();
        const root = document.getElementById("root");
        root.innerHTML = "";

        const opts = { onscreenParentId: "root" };
        const cmap = getColor() === "CUSTOM"
            ? getCustomColorMap(Prefs.get("customColor1"), Prefs.get("customColor2"), Prefs.get("customColor3"), Prefs.get("customColor4"))
            : COLOR_MAPS[getColor()];
        if (cmap) opts.colorMap = cmap;
        wf = new Waterfall(wfBufAry, pxPerLine, timeColumns, getDirection(), opts);
        currentColor = getColor();

        overlayCanvas = document.getElementById("axesCanvas");
        if (overlayCanvas) {
            overlayCanvas.width = timeColumns + Axes.FREQ_AXIS_W;
            overlayCanvas.height = pxPerLine + Axes.TIME_AXIS_H;
            overlayCtx = overlayCanvas.getContext("2d");
        }
        drawAxesOverlay();
    }

    function rebuildScale() {
        scaleMap = buildScaleMap(numBins, pxPerLine, audioCtx.sampleRate, getScale());
        currentScale = getScale();
        drawAxesOverlay();
    }

    function attachTooltipEvents() {
        const root = document.getElementById("root");
        const tooltip = document.getElementById("spectroTooltip");
        if (!root || !tooltip) return;

        root.addEventListener("mousemove", (e) => {
            if (appState === "stopped" || !audioCtx || !overlayCtx) {
                tooltip.style.display = "none";
                drawAxesOverlay();
                return;
            }

            const rect = root.getBoundingClientRect();
            const y = Math.max(0, Math.min(pxPerLine - 1, e.clientY - rect.top));

            drawAxesOverlay();
            if (Prefs.get("showHoverLine")) {
                Axes.drawHoverLine(overlayCtx, y, timeColumns);
            }

            if (Prefs.get("showTooltip")) {
                const frac = 1 - (y / Math.max(1, pxPerLine - 1));
                const hz = typeof scaleToHz !== "undefined" ? scaleToHz(frac, audioCtx.sampleRate / 2, getScale()) : 0;
                tooltip.textContent = hzToNoteString(hz);
                tooltip.style.left = `${e.clientX + 15}px`;
                tooltip.style.top = `${e.clientY + 15}px`;
                tooltip.style.display = "block";
            } else {
                tooltip.style.display = "none";
            }
        });

        root.addEventListener("mouseleave", () => {
            tooltip.style.display = "none";
            if (overlayCtx) drawAxesOverlay();
        });
    }

    function rebuildPipeline() {
        if (!analyser) return;
        analyser.fftSize = Prefs.get("fftSize");
        analyser.smoothingTimeConstant = Prefs.get("smoothing");
        analyser.minDecibels = Prefs.get("minDecibels");
        analyser.maxDecibels = Prefs.get("maxDecibels");
        buildAudioBuffers();
        rebuildScale();
        createWaterfall();
    }

    function updateButtons() {
        const start = document.getElementById("startBtn");
        const pause = document.getElementById("pauseBtn");
        const stop  = document.getElementById("stopBtn");
        start.disabled = appState === "running";
        pause.disabled = appState === "stopped";
        pause.textContent = appState === "paused" ? "Resume" : "Pause";
        stop.disabled  = appState === "stopped";
    }

    function showRestartHint(show) {
        const el = document.getElementById("restartHint");
        if (el) el.style.display = show ? "" : "none";
    }

    function updateLastNote() {
        const now = performance.now();
        if (now - lastNoteUpdateTs < 100) return;
        lastNoteUpdateTs = now;

        const result = Pitch.detect(frqBuf, audioCtx.sampleRate, analyser.fftSize);
        if (!result) return;

        const wrap = document.getElementById("lastNoteWrap");
        const txt = document.getElementById("lastNoteText");
        if (!wrap || !txt) return;
        txt.textContent = hzToNoteString(result.hz);
        if (wrap.style.display === "none") wrap.style.display = "";
    }

    let framesThisSecond = 0;
    let actualFPS = 60;
    let fpsUpdateTs = 0;

    function draw(timestamp) {
        if (appState !== "running") return;

        if (!timestamp) timestamp = performance.now();

        if (Prefs.get('renderMode') === 'frame') {
            if (!fpsUpdateTs) {
                fpsUpdateTs = timestamp;
            } else if (timestamp - fpsUpdateTs >= 1000) {
                let newFPS = (framesThisSecond * 1000) / (timestamp - fpsUpdateTs);
                fpsUpdateTs = timestamp;
                framesThisSecond = 0;

                let rawFPS = newFPS > 10 ? newFPS : 60;
                const commonRates = [60, 72, 75, 90, 120, 144, 165, 240, 360];
                let boundedFPS = commonRates.reduce((prev, curr) =>
                    Math.abs(curr - rawFPS) < Math.abs(prev - rawFPS) ? curr : prev
                );

                if (actualFPS !== boundedFPS) {
                    actualFPS = boundedFPS;
                    drawAxesOverlay();
                }
            }
            framesThisSecond++;
        } else {
            if (!nextDataTickTs) nextDataTickTs = timestamp;
        }

        if (getScale() !== currentScale) rebuildScale();
        // createWaterfall is now handled by Prefs event

        let pumped = false;

        if (Prefs.get('renderMode') === 'frame') {
            analyser.getByteFrequencyData(frqBuf);
            remapBins(frqBuf, mappedBuf, scaleMap);
            if (wf && wf.newLine) wf.newLine();
            pumped = true;
        } else {
            let catchupLines = 0;

            while (timestamp >= nextDataTickTs && catchupLines < 2) {
                analyser.getByteFrequencyData(frqBuf);
                remapBins(frqBuf, mappedBuf, scaleMap);
                if (wf && wf.newLine) wf.newLine();

                nextDataTickTs += DATA_FRAME_MS;
                pumped = true;
                catchupLines++;
            }

            if (timestamp >= nextDataTickTs) {
                nextDataTickTs = timestamp;
            }
        }

        if (pumped) {
            updateLastNote();
        }

        const audioEl = FilePlayer.getElement();
        if (audioEl && (audioEl.paused || audioEl.ended)) {
            pause();
            return;
        }
        animFrameId = requestAnimationFrame(draw);
    }

    function audioConstraints() {
        return {
            echoCancellation: !!Prefs.get("echoCancellation"),
            noiseSuppression: !!Prefs.get("noiseSuppression"),
            autoGainControl:  !!Prefs.get("autoGainControl")
        };
    }

    function ensureAudioCtx() {
        if (!audioCtx) {
            audioCtx = new AudioContext();
            analyser = audioCtx.createAnalyser();
        }
        analyser.fftSize = Prefs.get("fftSize");
        analyser.smoothingTimeConstant = Prefs.get("smoothing");
        analyser.minDecibels = Prefs.get("minDecibels");
        analyser.maxDecibels = Prefs.get("maxDecibels");
    }

    function startVisualization() {
        buildAudioBuffers();
        rebuildScale();
        createWaterfall();
        appState = "running";
        nextDataTickTs = 0;
        showRestartHint(false);
        updateButtons();
        draw();
    }

    async function start() {
        postSync('play');
        if (appState === "paused") {
            await audioCtx.resume();
            const audioEl = FilePlayer.getElement();
            if (audioEl) audioEl.play();
            appState = "running";
            nextDataTickTs = 0;
            updateButtons();
            draw();
            return;
        }

        ensureAudioCtx();
        const audioEl = FilePlayer.getElement();

        if (audioEl) {
            if (micSourceNode) micSourceNode.disconnect();
            analyser.disconnect();
            if (!fileSourceNode) fileSourceNode = audioCtx.createMediaElementSource(audioEl);
            fileSourceNode.disconnect();
            fileSourceNode.connect(analyser);
            analyser.connect(audioCtx.destination);

            try { await audioCtx.resume(); } catch(e){}
            audioEl.play();
            startVisualization();
            return;
        }

        setMicHint("waiting");
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: audioConstraints()
            });
        } catch { setMicHint("denied"); return; }

        try { await audioCtx.resume(); } catch(e){}
        setMicHint("granted");

        analyser.disconnect(); // don't play mic out to speakers
        if (fileSourceNode) fileSourceNode.disconnect();
        if (micSourceNode) micSourceNode.disconnect();

        micSourceNode = audioCtx.createMediaStreamSource(mediaStream);
        micSourceNode.connect(analyser);
        startVisualization();
    }

    async function pause() {
        if (appState !== "running") return;
        postSync('pause');
        appState = "paused";
        if (animFrameId) cancelAnimationFrame(animFrameId);
        if (wf) wf.stop();
        if (audioCtx && audioCtx.state === "running") {
            audioCtx.suspend().catch(e => console.warn(e));
        }
        const audioEl = FilePlayer.getElement();
        if (audioEl) audioEl.pause();
        updateButtons();
    }

    function clearDisplay() {
        if (wf) { wf.stop(); wf.clear(); }
        document.getElementById("root").innerHTML = "";
        const c = document.getElementById("axesCanvas");
        if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
    }

    function stop() {
        postSync('stop');
        appState = "stopped";
        if (animFrameId) cancelAnimationFrame(animFrameId);
        if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
        const audioEl = FilePlayer.getElement();
        if (audioEl) {
            audioEl.pause();
            audioEl.currentTime = 0;
        }
        clearDisplay();
        showRestartHint(false);
        updateButtons();
        if (!FilePlayer.hasFile()) checkMicPermission();
    }

    function reset() {
        if (wf) wf.clear();
        if (appState === "stopped") clearDisplay();
    }

    async function handleFileUpload(file) {
        if (!file || !file.type.startsWith("audio/")) return;
        stop();
        clearDisplay();
        ensureAudioCtx();

        FilePlayer.load(file, {
            onPlay:   () => { if (appState !== "running") start(); },
            onPause:  () => { if (appState === "running") pause(); },
            onSeeked: () => { const el = FilePlayer.getElement(); if (appState !== "running" && el && !el.paused) start(); },
            onEnded:  pause
        });

        const audioEl = FilePlayer.getElement();
        if (audioEl) audioEl.playbackRate = Prefs.get("playbackSpeed") || 1.0;

        start();
    }

    function onPrefChanged(key, value) {
        if (appState === "stopped" || !analyser) return;
        if (key === "smoothing") {
            analyser.smoothingTimeConstant = value;
        } else if (key === "fftSize" || key === "autoFit" || key === "direction" || key === "minFrequency" || key === "maxFrequency" || key === "minDecibels" || key === "maxDecibels") {
            rebuildPipeline();
        } else if (key === "colorType" || key.startsWith("customColor")) {
            createWaterfall();
        } else if (key === "showNoteGrid" || key === "noteGridColor" || key === "noteGridOpacity" || key === "noteGridCOpacity") {
            drawAxesOverlay();
        } else if (key === "playbackSpeed") {
            const audioEl = FilePlayer.getElement();
            if (audioEl) audioEl.playbackRate = value;
        } else if (key === "echoCancellation" || key === "noiseSuppression" || key === "autoGainControl") {
            showRestartHint(true);
        } else if (key === "enableSync" && typeof Sync !== "undefined") {
            Sync.reconnect();
        }
    }

    function onWindowResize() {
        if (!Prefs.get("autoFit")) return;
        if (appState === "stopped" || !analyser) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => rebuildPipeline(), 150);
    }

    function init() {
        Prefs.load();

        document.getElementById("startBtn").addEventListener('click', start);
        document.getElementById("pauseBtn").addEventListener('click', () => {
            if (appState === "running") pause();
            else if (appState === "paused") start();
        });
        document.getElementById("stopBtn").addEventListener('click', stop);
        document.getElementById("resetBtn").addEventListener('click', reset);

        document.getElementById("openFileBtn").addEventListener('click', () => {
            document.getElementById("audioFileInput").click();
        });
        document.getElementById("audioFileInput").addEventListener('change', (e) => {
            handleFileUpload(e.target.files[0]);
        });

        const closeAudioBtn = document.getElementById("closeAudioBtn");
        if (closeAudioBtn) {
            closeAudioBtn.addEventListener('click', () => {
                stop();
                FilePlayer.unload();
                if (fileSourceNode) fileSourceNode.disconnect();
                checkMicPermission();
            });
        }

        wireDropdown("data-scale", "scaleLabel", SCALE_NAMES, v => Prefs.set("scaleType", v));
        wireDropdown("data-color", "colorLabel", COLOR_NAMES, v => Prefs.set("colorType", v));
        wireDropdown("data-rendermode", "renderModeLabel", { "frame": "Smooth (Frame-based)", "strict": "Strict (Catch-up)" }, v => Prefs.set("renderMode", v));
        wireSettingsPanel(onPrefChanged);
        applyPrefsToUI();

        attachTooltipEvents();
        window.addEventListener('resize', onWindowResize);

        FilePlayer.setBarVisible(false);
        updateButtons();
        checkMicPermission();

        if (typeof Sync !== "undefined") {
            Sync.init({
                onPlay: () => { if (appState !== 'running') start(); },
                onPause: () => { if (appState === 'running') pause(); },
                onStop: () => { if (appState !== 'stopped') stop(); },
                onSeek: (time) => {
                    const audioEl = FilePlayer.getElement();
                    if (audioEl && Math.abs(audioEl.currentTime - time) > 0.5) {
                        audioEl.currentTime = time;
                    }
                }
            });
        }
    }

    return {
        init,
        // Host interface for transport-app.js. Read-only getters keep the
        // references live; helpers expose the few private functions the
        // transport feature needs to drive into App's audio graph.
        getAudioCtx: () => audioCtx,
        getAnalyser: () => analyser,
        getAppState: () => appState,
        getMicSourceNode: () => micSourceNode,
        audioConstraints,
        ensureAudioCtx,
        startVisualization,
        // Re-establish the legacy mic→analyser edge without re-acquiring the
        // stream. Used by transport-app after the transport returns to IDLE
        // to restore the spectrogram's live mic visualization.
        reconnectLegacyMicToAnalyser: () => {
            if (!micSourceNode) return false;
            try { micSourceNode.disconnect(); } catch (_) {}
            micSourceNode.connect(analyser);
            return true;
        },
        disconnectMediaSources: () => {
            if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
            if (micSourceNode) { micSourceNode.disconnect(); micSourceNode = null; }
            if (fileSourceNode) fileSourceNode.disconnect();
            const fileEl = FilePlayer.getElement();
            if (fileEl) fileEl.pause();
            try { analyser.disconnect(); } catch (_) { }
        }
    };
})();

window.addEventListener('DOMContentLoaded', App.init);

