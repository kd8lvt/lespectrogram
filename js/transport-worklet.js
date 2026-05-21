// Runs in the AudioWorklet (audio thread).
// Receives the compiled WASM module + shared memory from the main thread,
// instantiates locally, and calls transport_process every render quantum.

class TransportProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.ready          = false;
        this.exports        = null;
        this.heap           = null;
        this.outputPtr      = 0;
        this.outputChannels = 2;

        const opts = (options && options.processorOptions) || {};
        this._setup(opts).catch(err => {
            this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
        });
    }

    async _setup({ wasmBytes, sharedMemory, outputChannels }) {
        const instance = await WebAssembly.instantiate(wasmBytes, {
            env: { memory: sharedMemory, app_now_ms: () => Date.now() }
        });
        const inst = instance.instance || instance;
        if (inst.exports._initialize) inst.exports._initialize();

        this.exports        = inst.exports;
        this.heap           = new Float32Array(sharedMemory.buffer);
        this.outputPtr      = this.exports.transport_output_ptr() >>> 0;
        this.inputPtr       = this.exports.transport_input_ptr()  >>> 0;
        this.outputChannels = outputChannels | 0;
        this.ready          = true;
        this.port.postMessage({ type: 'ready' });
        console.log('[worklet] setup complete');
    }

    process(inputs, outputs) {
        if (!this.ready) return true;
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const frames   = output[0].length;
        const outChans = this.outputChannels;
        const heap     = this.heap;
        const outF32   = this.outputPtr >>> 2;
        const inF32    = this.inputPtr  >>> 2;

        // Interleave the worklet's input channels into scratchIn so the WASM
        // side has them at a stable layout. If no input is connected, zero.
        const input = inputs && inputs[0];
        if (input && input.length > 0 && input[0] && input[0].length === frames) {
            const inChans = input.length;
            for (let i = 0; i < frames; i++) {
                for (let c = 0; c < outChans; c++) {
                    const srcCh = (c < inChans) ? c : 0;  // mono -> stereo upmix
                    heap[inF32 + i * outChans + c] = input[srcCh][i];
                }
            }
        } else {
            // Zero the scratch_in region so RECORDING captures silence rather
            // than stale samples if the mic is momentarily disconnected.
            heap.fill(0, inF32, inF32 + frames * outChans);
        }

        this.exports.transport_process(frames);

        const have = Math.min(output.length, outChans);
        for (let ch = 0; ch < have; ch++) {
            const channel = output[ch];
            for (let i = 0; i < frames; i++) {
                channel[i] = heap[outF32 + i * outChans + ch];
            }
        }
        for (let ch = have; ch < output.length; ch++) {
            output[ch].fill(0);
        }
        return true;
    }
}

registerProcessor('transport-processor', TransportProcessor);
