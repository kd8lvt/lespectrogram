// All visualization math AND gesture state live in C++.
// This file only:
//   * Sizes the canvas + tracks devicePixelRatio.
//   * Each rAF tick: has C++ rasterize rects into a shared RGBA buffer,
//     blits it via a single putImageData, then walks the (text-only)
//     drawlist and renders labels/timestamps via Canvas2D fillText.
//   * Forwards mouse events into C++ and applies the cursor it returns.

const WaveRenderer = (() => {
    const CURSORS = ['', 'pointer', 'grab', 'grabbing', 'crosshair'];

    let canvas = null;
    let ctx = null;
    let onSeek = null;
    let rafId = null;
    let cssW = 1, cssH = 1, dpr = 1;
    let cmdsI32 = null, textBytes = null, cmdStrideI32 = 8;
    let pixelsU8 = null;       // Uint8ClampedArray over the WASM RGBA8888 buffer.
    let pixelsMaxW = 0, pixelsMaxH = 0;
    let copyBuf  = null;       // Non-shared fallback if ImageData rejects SAB views.
    let useCopyPath = false;
    let dragging = false;

    const decoder = new TextDecoder();

    function init(canvasEl, opts = {}) {
        canvas = canvasEl;
        ctx = canvas.getContext('2d');
        onSeek = opts.onSeek || null;

        canvas.addEventListener('mousedown', onCanvasDown);
        canvas.addEventListener('mousemove', onCanvasMove);
        canvas.addEventListener('mouseleave', () => { if (!dragging) canvas.style.cursor = ''; });
        window.addEventListener('mousemove', onWindowMove);
        window.addEventListener('mouseup', onWindowUp);
    }

    function ensureViews() {
        if (cmdsI32 || !Transport.isReady()) return cmdsI32 != null;
        const exp = Transport.exports;
        const buf = Transport.memory.buffer;
        const cmdsPtr = exp.transport_drawlist_cmds_ptr();
        const textPtr = exp.transport_drawlist_text_ptr();
        const maxCmds = exp.transport_drawlist_max_cmds();
        const textCap = exp.transport_drawlist_text_capacity();
        const pxPtr   = exp.transport_pixels_ptr();
        pixelsMaxW = exp.transport_pixels_max_w();
        pixelsMaxH = exp.transport_pixels_max_h();
        cmdStrideI32 = exp.transport_drawlist_cmd_stride_i32();
        cmdsI32   = new Int32Array(buf, cmdsPtr, maxCmds * cmdStrideI32);
        textBytes = new Uint8Array(buf, textPtr, textCap);
        pixelsU8  = new Uint8ClampedArray(buf, pxPtr, pixelsMaxW * pixelsMaxH * 4);
        return true;
    }

    function ensureCanvasSize() {
        const rect = canvas.getBoundingClientRect();
        cssW = Math.max(1, Math.floor(rect.width));
        cssH = Math.max(1, Math.floor(rect.height));
        dpr = window.devicePixelRatio || 1;
        const W = cssW * dpr, H = cssH * dpr;
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
        }
        return { W, H };
    }

    function cssCoords(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) };
    }

    function onCanvasDown(e) {
        if (e.button !== 0 || !Transport.isReady()) return;
        const { x, y } = cssCoords(e);
        // Modifier bit-flags must match Gestures.hpp Modifier enum (bit 0 = Shift).
        const mods = e.shiftKey ? 1 : 0;
        const cur = Transport.exports.transport_mouse_down(x, y, cssW, mods);
        canvas.style.cursor = CURSORS[cur] || '';
        if (Transport.exports.transport_drag_mode() !== 0) dragging = true;
    }
    function onCanvasMove(e) {
        if (dragging || !Transport.isReady()) return;
        const { x, y } = cssCoords(e);
        canvas.style.cursor = CURSORS[Transport.exports.transport_hover_cursor(x, y, cssW)] || '';
    }
    function onWindowMove(e) {
        if (!dragging || !Transport.isReady()) return;
        const { x, y } = cssCoords(e);
        canvas.style.cursor = CURSORS[Transport.exports.transport_mouse_move(x, y, cssW)] || '';
    }
    function onWindowUp(e) {
        if (!dragging || !Transport.isReady()) return;
        const { x, y } = cssCoords(e);
        const playFrame = Transport.exports.transport_mouse_up(x, y, cssW);
        dragging = false;
        canvas.style.cursor = '';
        if (playFrame >= 0 && onSeek) onSeek(playFrame, -1);
    }

    function syncZoomLabel() {
        const el = document.getElementById('transportZoomVal');
        if (!el) return;
        const z = Transport.getDisplayZoom() || 1;
        el.textContent = z >= 10 ? z.toFixed(0) + '×' : z.toFixed(1) + '×';
    }
    function updateTimeDisplay() {
        const el = document.getElementById('transportTime');
        if (!el) return;
        const sr = Transport.getSampleRate() || 1;
        const cur = Transport.getPos() / sr;
        const tot = Transport.getTrackLength() / sr;
        el.textContent = formatTime(cur) + ' / ' + formatTime(tot);
    }
    function formatTime(s) {
        if (!isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60);
        const sec = (s - m * 60).toFixed(2).padStart(5, '0');
        return m + ':' + sec;
    }

    // One putImageData blit per frame for all rect-based geometry. The pixel
    // buffer lives in WASM shared memory; we wrap it as a Uint8ClampedArray
    // view. Some browser versions reject SAB-backed views in the ImageData
    // constructor — if so, fall back to a per-frame copy into a non-shared
    // buffer.
    function blitPixels(W, H) {
        const len = W * H * 4;
        let imageData;
        if (!useCopyPath) {
            try {
                imageData = new ImageData(pixelsU8.subarray(0, len), W, H);
            } catch (_) {
                useCopyPath = true;
            }
        }
        if (useCopyPath) {
            if (!copyBuf || copyBuf.length < len) copyBuf = new Uint8ClampedArray(len);
            copyBuf.set(pixelsU8.subarray(0, len));
            imageData = new ImageData(copyBuf.subarray(0, len), W, H);
        }
        ctx.putImageData(imageData, 0, 0);
    }

    // Walk the drawlist for text commands and overlay them via Canvas2D's
    // fillText (keeps antialiased fonts without baking a bitmap atlas).
    // C++ now only emits CMD_FILL_TEXT (type 3); the dispatch is a guarded
    // fast path on that.
    function drawTextOverlay() {
        const count = Transport.exports.transport_drawlist_count();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let i = 0; i < count; i++) {
            const off = i * cmdStrideI32;
            if (cmdsI32[off] !== 3) continue;
            const x = cmdsI32[off + 1], y = cmdsI32[off + 2];
            const fontPx = cmdsI32[off + 3], align = cmdsI32[off + 4];
            const c    = cmdsI32[off + 5] >>> 0;
            const tOff = cmdsI32[off + 6], tLen = cmdsI32[off + 7];
            ctx.fillStyle = `rgba(${(c >>> 24) & 0xFF},${(c >>> 16) & 0xFF},${(c >>> 8) & 0xFF},${(c & 0xFF) / 255})`;
            ctx.font = fontPx + 'px sans-serif';
            ctx.textAlign = align === 0 ? 'left' : align === 2 ? 'right' : 'center';
            ctx.textBaseline = 'top';
            const copy = new Uint8Array(tLen);
            copy.set(textBytes.subarray(tOff, tOff + tLen));
            ctx.fillText(decoder.decode(copy), x, y);
        }
    }

    function tick() {
        if (!Transport.isReady() || !ensureViews()) {
            rafId = requestAnimationFrame(tick);
            return;
        }
        const { W, H } = ensureCanvasSize();
        // Clamp render dims to the WASM pixel buffer's static capacity. On
        // very wide displays we under-render rather than overflow.
        const renderW = Math.min(W, pixelsMaxW);
        const renderH = Math.min(H, pixelsMaxH);
        Transport.exports.transport_render_drawlist(renderW, renderH, dpr);
        blitPixels(renderW, renderH);
        drawTextOverlay();
        updateTimeDisplay();
        syncZoomLabel();
        rafId = requestAnimationFrame(tick);
    }

    function startLoop() { if (!rafId) rafId = requestAnimationFrame(tick); }
    function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }
    function refresh() { startLoop(); }

    return { init, refresh, startLoop, stopLoop };
})();
