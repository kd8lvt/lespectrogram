// Thin adapter over the WASM transport. Bootstrap + memory-mapped views.
//
// Everything lives in C++: 
// transport state, regions, render math, gestures --- mostly because I am not confident with JS
// JS only handles browser-only concerns: WebAssembly + Web
// Audio + AudioWorklet bootstrap, file decoding, text encode/decode for
// labels, and exposing the shared-memory views to other JS modules.

const Transport = (() => {
    const WASM_URL = 'wasm/transport.wasm';
    const WORKLET_URL = 'js/transport-worklet.js';
    const PAGES = 2048;     // 128 MiB shared

    // TransportStateView i32 indices (mirror Transport.hpp).
    const S_STATE = 0, S_POS = 1, S_CUR_REGION = 3, S_SEL = 4,
        S_DISPLAY_GAIN_F32 = 12, S_DISPLAY_ZOOM_F32 = 13,
        S_CHANNELS = 8, S_SAMPLE_RATE = 9;

    // Region i32 indices (mirror Region.hpp).
    const R_LABEL_LEN = 5, R_STRIDE_I32 = 16;

    let audioCtx = null;
    let memory = null;
    let exports_ = null;
    let workletNode = null;
    let workletReady = false;
    let outputChannels = 2;

    let stateI32 = null, stateF32 = null;
    let regionsI32 = null;
    let labelsBytes = null;
    let MAX_LABEL = 32;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    function isCrossOriginIsolated() {
        return typeof self !== 'undefined' && self.crossOriginIsolated === true;
    }

    async function init(ctx, channels = 2) {
        if (workletReady) return workletNode;
        if (!isCrossOriginIsolated()) {
            throw new Error('Transport requires cross-origin isolation (COOP/COEP). Reload the page; the service worker should enable it on the next load.');
        }
        audioCtx = ctx;
        outputChannels = channels;

        memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES, shared: true });

        const bytes = await (await fetch(WASM_URL)).arrayBuffer();
        const module = await WebAssembly.compile(bytes);
        const imports = { env: { memory, app_now_ms: () => Date.now() } };

        const instance = await WebAssembly.instantiate(module, imports);
        if (instance.exports._initialize) instance.exports._initialize();
        exports_ = instance.exports;

        const maxRegions = exports_.transport_max_regions();
        MAX_LABEL = exports_.transport_max_label();
        const statePtr = exports_.transport_state_ptr();
        const regionsPtr = exports_.transport_regions_ptr();
        const labelsPtr = exports_.transport_labels_ptr();
        stateI32 = new Int32Array(memory.buffer, statePtr, 16);
        stateF32 = new Float32Array(memory.buffer, statePtr, 16);
        regionsI32 = new Int32Array(memory.buffer, regionsPtr, maxRegions * R_STRIDE_I32);
        labelsBytes = new Uint8Array(memory.buffer, labelsPtr, maxRegions * MAX_LABEL);

        await audioCtx.audioWorklet.addModule(WORKLET_URL);
        workletNode = new AudioWorkletNode(audioCtx, 'transport-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [outputChannels],
            processorOptions: { wasmBytes: bytes, sharedMemory: memory, outputChannels }
        });
        const ready = new Promise((resolve, reject) => {
            workletNode.port.onmessage = (e) => {
                if (!e.data) return;
                if (e.data.type === 'ready') { workletReady = true; resolve(); }
                else if (e.data.type === 'error') reject(new Error('Worklet: ' + e.data.message));
            };
        });
        workletNode.connect(audioCtx.destination);
        try { await audioCtx.resume(); } catch (_) { }
        await ready;

        // The worklet's instantiate re-applies data segments against the same
        // shared memory; defaults set by transport_init must come *after* the
        // worklet is up so they don't get clobbered.
        exports_.transport_init(audioCtx.sampleRate, outputChannels);
        return workletNode;
    }

    async function loadFile(file) {
        if (!exports_) throw new Error('Transport.init() first');
        if (!file) return null;

        const decoded = await audioCtx.decodeAudioData(await file.arrayBuffer());
        const cap = exports_.transport_audio_buffer_capacity_frames();
        const writeFrames = Math.min(decoded.length, cap);
        const srcChans = Math.min(decoded.numberOfChannels, outputChannels);

        const heap = new Float32Array(memory.buffer);
        const bufPtr = exports_.transport_audio_buffer_ptr() >>> 2;
        const ch0 = decoded.getChannelData(0);
        const ch1 = (srcChans > 1) ? decoded.getChannelData(1) : ch0;

        if (outputChannels === 2) {
            for (let i = 0; i < writeFrames; i++) {
                heap[bufPtr + i * 2] = ch0[i];
                heap[bufPtr + i * 2 + 1] = ch1[i];
            }
        } else {
            for (let i = 0; i < writeFrames; i++) heap[bufPtr + i] = ch0[i];
        }

        exports_.transport_load(writeFrames, outputChannels, decoded.sampleRate);
        if (file.name) setRegionLabel(0, file.name);

        return {
            frames: writeFrames,
            channels: outputChannels,
            sampleRate: decoded.sampleRate,
            durationSec: writeFrames / decoded.sampleRate
        };
    }

    function setRegionLabel(id, name) {
        if (!exports_) return;
        const enc = encoder.encode(String(name));
        const len = Math.min(enc.length, MAX_LABEL);
        const ptr = exports_.transport_label_scratch_ptr() >>> 0;
        new Uint8Array(memory.buffer, ptr, MAX_LABEL).set(enc.subarray(0, len));
        exports_.transport_region_set_label_from_scratch(id | 0, len);
    }

    function getRegionLabel(id) {
        if (!regionsI32 || !labelsBytes) return '';
        const len = Atomics.load(regionsI32, id * R_STRIDE_I32 + R_LABEL_LEN);
        if (len <= 0) return '';
        const off = id * MAX_LABEL;
        const copy = new Uint8Array(len);
        copy.set(labelsBytes.subarray(off, off + len));
        return decoder.decode(copy);
    }

    // Region snapshot (combines several memory reads + label decode).
    function getRegion(id) {
        if (!regionsI32 || !exports_) return null;
        const i = id | 0;
        return {
            id: i,
            trackStartFrame: Atomics.load(regionsI32, i * R_STRIDE_I32 + 0),
            bufferOffsetFrames: regionsI32[i * R_STRIDE_I32 + 1],
            lengthFrames: Atomics.load(regionsI32, i * R_STRIDE_I32 + 2),
            active: Atomics.load(regionsI32, i * R_STRIDE_I32 + 3) === 1,
            channels: regionsI32[i * R_STRIDE_I32 + 4],
            label: getRegionLabel(i)
        };
    }

    // Trivial state reads — direct memory; left here so callers don't need
    // to know offsets.
    const getState = () => stateI32 ? Atomics.load(stateI32, S_STATE) : 0;
    const getPos = () => stateI32 ? Atomics.load(stateI32, S_POS) : 0;
    const getCurrentRegionId = () => stateI32 ? Atomics.load(stateI32, S_CUR_REGION) : -1;
    const getSelectedRegion = () => stateI32 ? Atomics.load(stateI32, S_SEL) : -1;
    const getDisplayZoom = () => stateF32 ? stateF32[S_DISPLAY_ZOOM_F32] : 1.0;
    const getSampleRate = () => stateI32 ? stateI32[S_SAMPLE_RATE] : (audioCtx ? audioCtx.sampleRate : 0);
    const getTrackLength = () => exports_ ? exports_.transport_track_length() : 0;

    // State-machine actions (delegate to C ABI; clamping/validation in C++).
    const play = () => { if (exports_) exports_.transport_play(); };
    const stop = () => { if (exports_) exports_.transport_stop(); };
    const record = () => exports_ ? exports_.transport_record() : -1;
    const setPos = (f) => { if (exports_) exports_.transport_set_pos(f | 0); };
    const setDisplayZoom = (z) => { if (exports_) exports_.transport_set_display_zoom(+z); };
    const setDisplayGain = (g) => { if (stateF32) stateF32[S_DISPLAY_GAIN_F32] = +g; };
    const deactivateRegion = (id) => { if (exports_) exports_.transport_region_deactivate(id | 0); };
    const setLoopEnabled = (on) => { if (exports_) exports_.transport_set_loop_enabled(on ? 1 : 0); };
    const getLoopEnabled = () => exports_ ? exports_.transport_get_loop_enabled() : 0;

    return {
        init, loadFile,
        getRegion, getRegionLabel, setRegionLabel,
        getState, getPos, getCurrentRegionId, getSelectedRegion,
        getDisplayZoom, getSampleRate, getTrackLength,
        play, stop, record, setPos, setDisplayZoom, setDisplayGain, deactivateRegion,
        setLoopEnabled, getLoopEnabled,
        getNode: () => workletNode,
        isReady: () => workletReady,
        STATE_IDLE: 0, STATE_PLAYING: 1, STATE_RECORDING: 2,
        get memory() { return memory; },
        get exports() { return exports_; }
    };
})();
