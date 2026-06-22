// Frequency-axis scale conversion and bin remapping.
const SCALE_NAMES = { MEL: "Mel", LINEAR: "Linear", OCTAVE: "Octave", LOG: "Log" };

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

function scaleToHz(frac, halfSampleRate, scale) {
    const userMin = typeof Prefs !== "undefined" ? parseFloat(Prefs.get("minFrequency") || 20) : 20;
    const userMax = typeof Prefs !== "undefined" ? parseFloat(Prefs.get("maxFrequency") || halfSampleRate) : halfSampleRate;
    const minHz = Math.max(1, userMin);
    const maxHz = Math.min(halfSampleRate, userMax);

    switch (scale) {
        case "MEL":
            return melToHz(hzToMel(minHz) + frac * (hzToMel(maxHz) - hzToMel(minHz)));
        case "LOG":
            return Math.pow(10, Math.log10(minHz) + frac * (Math.log10(maxHz) - Math.log10(minHz)));
        case "OCTAVE":
            return Math.pow(2, Math.log2(minHz) + frac * (Math.log2(maxHz) - Math.log2(minHz)));
        case "LINEAR":
        default:
            return minHz + frac * (maxHz - minHz);
    }
}

function buildScaleMap(numBins, numPx, sampleRate, scale) {
    const map = new Float32Array(numPx);
    const halfSampleRate = sampleRate / 2;
    for (let px = 0; px < numPx; px++) {
        const hz = scaleToHz(px / (numPx - 1), halfSampleRate, scale);
        map[px] = (hz / halfSampleRate) * (numBins - 1);
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

function hzToNoteString(hz) {
    if (hz <= 0 || !isFinite(hz)) return "";
    const A4 = 440;
    const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    // 69 is midi note for A4
    const midiNum = Math.round(12 * Math.log2(hz / A4) + 69);
    if (midiNum < 0 || midiNum > 127) return `${hz.toFixed(1)} Hz`;
    const octave = Math.floor(midiNum / 12) - 1;
    const noteName = noteNames[midiNum % 12];

    //Solfege
    let solfege="";
    const doIdx = noteNames.indexOf(document.getElementById("doNote").value);
    console.log(doIdx)
    if (doIdx >= 0) {
        const doOffset = (midiNum - doIdx) % 12;
        const solfegeNames = ["Do","Di","Re","Ri","Mi","Fa","Fi","So","Si","La","Li","Ti"];
        solfege=` (${solfegeNames[doOffset]})`;
    }

    return `${noteName}${octave} (${hz.toFixed(1)} Hz)${solfege}`;
}

function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function hzToScaleFrac(hz, halfSampleRate, scale) {
    const userMin = typeof Prefs !== "undefined" ? parseFloat(Prefs.get("minFrequency") || 20) : 20;
    const userMax = typeof Prefs !== "undefined" ? parseFloat(Prefs.get("maxFrequency") || halfSampleRate) : halfSampleRate;
    const minHz = Math.max(1, userMin);
    const maxHz = Math.min(halfSampleRate, userMax);

    if (hz <= minHz) return 0;
    if (hz >= maxHz) return 1;

    switch (scale) {
        case "MEL":
            return (hzToMel(hz) - hzToMel(minHz)) / (hzToMel(maxHz) - hzToMel(minHz));
        case "LOG":
            return (Math.log10(hz) - Math.log10(minHz)) / (Math.log10(maxHz) - Math.log10(minHz));
        case "OCTAVE":
            return (Math.log2(hz) - Math.log2(minHz)) / (Math.log2(maxHz) - Math.log2(minHz));
        case "LINEAR":
        default:
            return (hz - minHz) / (maxHz - minHz);
    }
}

