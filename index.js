/**
 * Le Spectrogram - Real-time audio frequency visualization
 * Displays microphone input as a spectrogram with multiple frequency scales
 */

// ============================================================================
// Configuration & State
// ============================================================================

const SCALE_TYPES = {
    LINEAR: 'LINEAR',
    MEL: 'MEL',
    LOG: 'LOG',
    OCTAVE: 'OCTAVE'
};

const PALETTE_TYPES = {
    ORIGINAL: 'original',
    COLORBLIND: 'colorblind'
};

const AUDIO_CONFIG = {
    constraints: { video: false, audio: true },
    waterfall: {
        direction: 'right',
        widthMultiplier: 3,
        heightMultiplier: 8
    }
};

let scaleType = SCALE_TYPES.MEL;
let paletteType = PALETTE_TYPES.ORIGINAL;
let audioCtx = null;
let stream = null;
let analyser = null;
let waterfallDisplay = null;
let isListening = false;


function linearToMel(linearFreq) {
    return 2595 * Math.log10(1 + linearFreq / 700);
}

function melToLinear(melFreq) {
    return 700 * (Math.pow(10, melFreq / 2595) - 1);
}

function linearToLog(linearFreq) {
    return linearFreq > 0 ? Math.log(linearFreq) : -10;
}

function logToLinear(logFreq) {
    return Math.exp(logFreq);
}

function linearToOctave(linearFreq, refFreq = 16.35) {
    return linearFreq > 0 ? Math.log2(linearFreq / refFreq) : -10;
}

function octaveToLinear(octave, refFreq = 16.35) {
    return refFreq * Math.pow(2, octave);
}

function scaleFrequencyBuffer(originalBuffer, scaleType, nyquistFreq) {
    const scaledBuffer = new Uint8Array(originalBuffer.length);
    const bufferLength = originalBuffer.length;
    
    if (scaleType === SCALE_TYPES.LINEAR) {
        return originalBuffer;
    }
    
    let maxTransformed = getMaxTransformedFrequency(scaleType, nyquistFreq);
    
    for (let i = 0; i < bufferLength; i++) {
        const normalizedPos = i / bufferLength;
        const transformedFreq = normalizedPos * maxTransformed;
        const linearFreq = inverseTransformFrequency(transformedFreq, scaleType);
        
        const sourceIndex = Math.max(0, Math.min(
            bufferLength - 1,
            Math.round((linearFreq / nyquistFreq) * bufferLength)
        ));
        
        scaledBuffer[i] = originalBuffer[sourceIndex];
    }
    
    return scaledBuffer;
}

function getMaxTransformedFrequency(scaleType, nyquistFreq) {
    switch (scaleType) {
        case SCALE_TYPES.MEL:
            return linearToMel(nyquistFreq);
        case SCALE_TYPES.LOG:
            return linearToLog(nyquistFreq);
        case SCALE_TYPES.OCTAVE:
            return linearToOctave(nyquistFreq);
        default:
            return nyquistFreq;
    }
}

function inverseTransformFrequency(transformedFreq, scaleType) {
    switch (scaleType) {
        case SCALE_TYPES.MEL:
            return melToLinear(transformedFreq);
        case SCALE_TYPES.LOG:
            return logToLinear(transformedFreq);
        case SCALE_TYPES.OCTAVE:
            return octaveToLinear(transformedFreq);
        default:
            return transformedFreq;
    }
}

function getColorblindPalette() {
    const palette = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r, g, b;
        
        if (t < 0.25) {
            const x = t * 4;
            r = Math.round(0);
            g = Math.round(100 * x);
            b = Math.round(150 + 105 * x);
        } else if (t < 0.5) {
            const x = (t - 0.25) * 4;
            r = Math.round(0);
            g = Math.round(100 + 155 * x);
            b = Math.round(255 - 105 * x);
        } else if (t < 0.75) {
            const x = (t - 0.5) * 4;
            r = Math.round(255 * x);
            g = Math.round(255);
            b = Math.round(150 - 150 * x);
        } else {
            const x = (t - 0.75) * 4;
            r = Math.round(255);
            g = Math.round(255 - 55 * x);
            b = Math.round(0);
        }
        
        palette.push([r, g, b, 255]);
    }
    return palette;
}

function changePalette(newPalette) {
    if (Object.values(PALETTE_TYPES).includes(newPalette)) {
        paletteType = newPalette;
        const logElement = document.getElementById("log");
        if (logElement) {
            const paletteName = newPalette === PALETTE_TYPES.COLORBLIND ? 'Colorblind Friendly' : 'Original';
            logElement.textContent = `Palette: ${paletteName}${waterfallDisplay ? ' (restart to apply)' : ''}`;
        }
    }
}

function pause() {
    if (waterfallDisplay && isListening) {
        waterfallDisplay.stop();
        document.getElementById("pause").style.display = "none";
        document.getElementById("resume").style.display = "inline";
    }
}

function resume() {
    if (waterfallDisplay && isListening) {
        waterfallDisplay.start();
        document.getElementById("resume").style.display = "none";
        document.getElementById("pause").style.display = "inline";
    }
}

function reset() {
    if (waterfallDisplay) {
        waterfallDisplay.clear();
    }
}

function changeScale(newScale) {
    if (Object.values(SCALE_TYPES).includes(newScale)) {
        scaleType = newScale;
        const logElement = document.getElementById("log");
        if (logElement) {
            logElement.textContent = `Scale: ${newScale}`;
        }
    }
}

// ============================================================================
// Audio Initialization & Capture
// ============================================================================

async function init() {
    try {
        audioCtx = new AudioContext();
        document.getElementById("start").style.visibility = "hidden";
        document.getElementById("pause").style.display = "inline";
        document.getElementById("reset").style.display = "inline";
        
        stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONFIG.constraints);
        isListening = true;
        setupAudioCapture(stream);
    } catch (error) {
        handleAudioError(error);
    }
}

function setupAudioCapture(stream) {
    analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    
    const frequencyBinCount = analyser.frequencyBinCount;
    const nyquistFreq = audioCtx.sampleRate / 2;
    
    const frequencyBuffer = new Uint8Array(frequencyBinCount);
    let scaledBuffer = new Uint8Array(frequencyBinCount);
    
    const basePoints = 50;
    const pointsPerLine = Math.round((basePoints * frequencyBinCount) / 256);
    const width = pointsPerLine * AUDIO_CONFIG.waterfall.widthMultiplier;
    const height = pointsPerLine * AUDIO_CONFIG.waterfall.heightMultiplier;
    
    const bufferWrapper = { buffer: scaledBuffer };
    
    const waterfallOptions = { onscreenParentId: "root" };
    if (paletteType === PALETTE_TYPES.COLORBLIND) {
        waterfallOptions.colormap = getColorblindPalette();
    }
    
    waterfallDisplay = new Waterfall(
        bufferWrapper,
        width,
        height,
        AUDIO_CONFIG.waterfall.direction,
        waterfallOptions
    );
    
    function captureAndDisplay() {
        analyser.getByteFrequencyData(frequencyBuffer, 0);
        
        const transformedData = scaleFrequencyBuffer(
            frequencyBuffer,
            scaleType,
            nyquistFreq
        );
        
        scaledBuffer.set(transformedData);
        requestAnimationFrame(captureAndDisplay);
    }
    
    captureAndDisplay();
    waterfallDisplay.start();
}

function handleAudioError(error) {
    console.error("Audio error:", error);
    const logElement = document.getElementById("log");
    if (logElement) {
        logElement.textContent = error.name === "NotAllowedError"
            ? "Microphone permission denied"
            : "Microphone access error";
    }
    document.getElementById("start").style.visibility = "visible";
    document.getElementById("pause").style.display = "none";
    document.getElementById("resume").style.display = "none";
    document.getElementById("reset").style.display = "none";
    isListening = false;
}


window.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById("start");
    if (startButton) {
        startButton.addEventListener('click', init);
    }
    
    const pauseButton = document.getElementById("pause");
    if (pauseButton) {
        pauseButton.addEventListener('click', pause);
    }
    
    const resumeButton = document.getElementById("resume");
    if (resumeButton) {
        resumeButton.addEventListener('click', resume);
    }
    
    const resetButton = document.getElementById("reset");
    if (resetButton) {
        resetButton.addEventListener('click', reset);
    }
});
