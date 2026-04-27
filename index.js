let scaleType = "MEL";
let colorType = "JET";

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
let pxPerLine = 0;
let wfNumPts = 0;
let currentScale = null;
let scaleMap = null;


function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

function scaleToHz(frac, nyquist, scale) {
    const minHz = 20;
    switch (scale) {
        case "MEL":
            return melToHz(hzToMel(minHz) + frac * (hzToMel(nyquist) - hzToMel(minHz)));
        case "LOG":
            return Math.pow(10, Math.log10(minHz) + frac * (Math.log10(nyquist) - Math.log10(minHz)));
        case "OCTAVE":
            return Math.pow(2, Math.log2(minHz) + frac * (Math.log2(nyquist) - Math.log2(minHz)));
        case "LINEAR":
        default:
            return frac * nyquist;
    }
}

function buildScaleMap(numBins, numPx, sampleRate, scale) {
    const map = new Float32Array(numPx);
    const nyquist = sampleRate / 2;
    for (let px = 0; px < numPx; px++) {
        const hz = scaleToHz(px / (numPx - 1), nyquist, scale);
        map[px] = (hz / nyquist) * (numBins - 1);
    }
    return map;
}

function remapBins(srcBuf, dstBuf, scaleMap) {
    for (let px = 0; px < scaleMap.length; px++) {
        const binF = scaleMap[px];
        const lo = Math.floor(binF);
        const hi = Math.min(lo + 1, srcBuf.length - 1);
        const t = binF - lo;
        dstBuf[px] = srcBuf[lo] * (1 - t) + srcBuf[hi] * t;
    }
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function buildGradientMap(stops) {
    const map = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let s0 = stops[0], s1 = stops[stops.length - 1];
        for (let j = 0; j < stops.length - 1; j++) {
            if (t >= stops[j][0] && t <= stops[j + 1][0]) {
                s0 = stops[j]; s1 = stops[j + 1]; break;
            }
        }
        const f = (t - s0[0]) / (s1[0] - s0[0] || 1);
        map.push([lerp(s0[1], s1[1], f), lerp(s0[2], s1[2], f), lerp(s0[3], s1[3], f), 255]);
    }
    map.push([0, 0, 0, 0]);
    return map;
}

const COLOR_MAPS = {
    JET:       null,
    GRAYSCALE: buildGradientMap([[0,0,0,0],[1,255,255,255]]),
    HEAT:      buildGradientMap([[0,0,0,0],[0.33,180,0,0],[0.66,255,200,0],[1,255,255,255]]),
    MAGMA:     buildGradientMap([[0,0,0,4],[0.13,28,16,68],[0.25,79,18,123],[0.38,129,37,129],[0.5,181,54,122],[0.63,229,89,100],[0.75,251,136,97],[0.88,254,194,140],[1,252,253,191]]),
    PLASMA:    buildGradientMap([[0,13,8,135],[0.13,75,3,161],[0.25,125,3,168],[0.38,168,34,150],[0.5,203,70,121],[0.63,229,107,93],[0.75,248,148,65],[0.88,253,195,40],[1,240,249,33]]),
    CIVIDIS:   buildGradientMap([[0,0,32,77],[0.13,0,52,110],[0.25,39,72,108],[0.38,77,91,105],[0.5,109,112,108],[0.63,143,132,108],[0.75,181,155,96],[0.88,222,181,67],[1,253,231,37]]),
    VIRIDIS:   buildGradientMap([[0,68,1,84],[0.25,59,82,139],[0.5,33,145,140],[0.75,94,201,98],[1,253,231,37]]),
    INFERNO:   buildGradientMap([[0,0,0,4],[0.25,87,16,110],[0.5,188,55,84],[0.75,249,142,9],[1,252,255,164]])
};

const MIC_HINTS = {
    prompt:  { cls: "alert-info",    text: "This app needs microphone access to visualize your voice. Click <strong>Start</strong> to begin." },
    waiting: { cls: "alert-warning", text: "Look for a popup at the <strong>top of your browser</strong> and click <strong>Allow</strong>." },
    denied:  { cls: "alert-danger",  text: "Microphone access was denied. Click the lock icon in your address bar, then <strong>Site settings</strong>, then allow <strong>Microphone</strong> and reload." },
    granted: null
};

function setMicHint(state) {
    const hint = document.getElementById("micHint");
    if (!hint) return;
    const info = MIC_HINTS[state];
    if (!info) { hint.style.display = "none"; return; }
    hint.className = `alert mt-2 text-center ${info.cls}`;
    hint.innerHTML = info.text;
    hint.style.display = "";
}

async function checkMicPermission() {
    try {
        const result = await navigator.permissions.query({name: 'microphone'});
        setMicHint(result.state);
        result.addEventListener('change', () => setMicHint(result.state));
    } catch { setMicHint("prompt"); }
}

function createWaterfall() {
    if (wf) wf.stop();
    document.getElementById("root").innerHTML = "";
    const opts = {onscreenParentId: "root"};
    const cmap = COLOR_MAPS[colorType];
    if (cmap) opts.colorMap = cmap;
    wf = new Waterfall(wfBufAry, pxPerLine, wfNumPts * 8, "right", opts);
    currentColor = colorType;
    wf.start();
}

function rebuildScale() {
    scaleMap = buildScaleMap(numBins, pxPerLine, audioCtx.sampleRate, scaleType);
    currentScale = scaleType;
    buildFreqAxis("freqAxis", audioCtx.sampleRate, scaleType, pxPerLine, 8);
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

function draw() {
    if (appState !== "running") return;
    if (scaleType !== currentScale) rebuildScale();
    if (colorType !== currentColor) createWaterfall();
    analyser.getByteFrequencyData(frqBuf);
    remapBins(frqBuf, mappedBuf, scaleMap);
    animFrameId = requestAnimationFrame(draw);
}

async function doStart() {
    if (appState === "paused") {
        await audioCtx.resume();
        appState = "running";
        wf.start();
        updateButtons();
        draw();
        return;
    }

    setMicHint("waiting");
    try {
        audioCtx = new AudioContext();
        mediaStream = await navigator.mediaDevices.getUserMedia({video: false, audio: true});
    } catch { setMicHint("denied"); return; }

    setMicHint("granted");
    analyser = audioCtx.createAnalyser();
    audioCtx.createMediaStreamSource(mediaStream).connect(analyser);

    numBins = analyser.frequencyBinCount;
    wfNumPts = 50 * numBins / 256;
    pxPerLine = wfNumPts * 3;
    frqBuf = new Uint8Array(numBins);
    mappedBuf = new Uint8Array(pxPerLine);
    wfBufAry = {buffer: mappedBuf};

    rebuildScale();
    buildTimeAxis("timeAxis", 8, 8);
    createWaterfall();
    appState = "running";
    updateButtons();
    draw();
}

async function doPause() {
    if (appState === "running") {
        appState = "paused";
        if (animFrameId) cancelAnimationFrame(animFrameId);
        wf.stop();
        await audioCtx.suspend();
        updateButtons();
    } else if (appState === "paused") {
        await doStart();
    }
}

function doStop() {
    appState = "stopped";
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (wf) { wf.stop(); wf.clear(); }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    document.getElementById("root").innerHTML = "";
    updateButtons();
    checkMicPermission();
}

function doReset() {
    if (wf) wf.clear();
}

function buildAxisTicks(containerId, ticks, makeTick) {
    const axis = document.getElementById(containerId);
    if (!axis) return;
    axis.innerHTML = "";
    for (let i = 0; i <= ticks; i++) {
        const cfg = makeTick(i / ticks);
        const el = document.createElement("div");
        el.className = cfg.className;
        el.style.cssText = `position:absolute;${cfg.posProp}:${cfg.posPercent}%;transform:${cfg.transform}`;
        el.textContent = cfg.label;
        axis.appendChild(el);
    }
}

function formatHz(hz) {
    return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${hz}`;
}

function buildFreqAxis(containerId, sampleRate, scale, numPx, ticks = 6) {
    const nyquist = sampleRate / 2;
    buildAxisTicks(containerId, ticks, (frac) => ({
        className: "freq-tick",
        posProp: "top",
        posPercent: frac * 100,
        transform: "translateY(-50%)",
        label: formatHz(Math.round(scaleToHz(1 - frac, nyquist, scale)))
    }));
}

function buildTimeAxis(containerId, secondsVisible = 8, ticks = 8) {
    buildAxisTicks(containerId, ticks, (frac) => ({
        className: "time-tick",
        posProp: "left",
        posPercent: frac * 100,
        transform: "translateX(-50%)",
        label: `${((1 - frac) * secondsVisible).toFixed(1)}s`
    }));
}

const SCALE_NAMES = {MEL: "Mel", LINEAR: "Linear", OCTAVE: "Octave", LOG: "Log"};
const COLOR_NAMES = {
    JET: "Jet", GRAYSCALE: "Grayscale", HEAT: "Heat",
    MAGMA: "Magma", PLASMA: "Plasma", CIVIDIS: "Cividis (Colorblind)",
    VIRIDIS: "Viridis", INFERNO: "Inferno"
};

function wireDropdown(attr, labelId, nameMap, setter) {
    document.querySelectorAll(`[${attr}]`).forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            const val = el.dataset[attr.replace('data-', '')];
            setter(val);
            document.getElementById(labelId).textContent = nameMap[val] || val;
        });
    });
}



window.addEventListener('DOMContentLoaded', () => {
	document.getElementById("startBtn").addEventListener('click', doStart);
	document.getElementById("pauseBtn").addEventListener('click', doPause);
	document.getElementById("stopBtn").addEventListener('click', doStop);
	document.getElementById("resetBtn").addEventListener('click', doReset);

	document.querySelector('#scale').addEventListener('change', e => {
		scaleType = e.target.value;
	});
	document.querySelector('#color').addEventListener('change', e => {
		colorType = e.target.value;
	});

	updateButtons();
	checkMicPermission();
});
