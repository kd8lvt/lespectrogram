#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>

#include "Color.hpp"

// Software-rasterized RGBA8888 pixel buffer. C++ writes; JS wraps as a
// Uint8ClampedArray view over WASM shared memory and hands it to
// putImageData() in a single blit per frame.
//
// Pixel layout matches ImageData: byte order R, G, B, A. Coordinates are
// physical pixels (caller has scaled by dpr).
//
// Capacity is a static upper bound — we never reallocate. Current frame
// dimensions are tracked separately so the JS-side Uint8ClampedArray view
// can be sized to exactly W*H*4 each frame.
struct PixelBuffer
{
    static constexpr int32_t MAX_W = 4096;
    static constexpr int32_t MAX_H = 512;

    alignas(16) uint8_t data[MAX_W * MAX_H * 4];

    int32_t w = 0;
    int32_t h = 0;
    int32_t strideBytes = 0;  // = w * 4; matches the tight packing
                              // putImageData expects on the JS side.

    void begin(int32_t Wphys, int32_t Hphys)
    {
        w = std::clamp(Wphys, 0, MAX_W);
        h = std::clamp(Hphys, 0, MAX_H);
        strideBytes = w * 4;
    }

    // Solid clear (opaque alpha implied).
    void clear(uint32_t rgba)
    {
        uint8_t r, g, b, a;
        color::unpack(rgba, r, g, b, a);
        for (int32_t y = 0; y < h; ++y)
        {
            uint8_t* row = data + (y * strideBytes);
            for (int32_t x = 0; x < w; ++x)
            {
                row[x * 4 + 0] = r;
                row[x * 4 + 1] = g;
                row[x * 4 + 2] = b;
                row[x * 4 + 3] = a;
            }
        }
    }

    // Axis-aligned filled rect with src-over alpha compositing. Clipped to
    // the active frame. Opaque alpha takes a fast write path; otherwise
    // per-pixel blend.
    void fillRect(int32_t x, int32_t y, int32_t W, int32_t H, uint32_t rgba)
    {
        int32_t x0 = std::max(0, x);
        int32_t y0 = std::max(0, y);
        int32_t x1 = std::min(w, x + W);
        int32_t y1 = std::min(h, y + H);
        if (x1 <= x0 || y1 <= y0) { return; }

        uint8_t sr, sg, sb, sa;
        color::unpack(rgba, sr, sg, sb, sa);

        if (sa == 0) { return; }

        if (sa == 255)
        {
            for (int32_t yy = y0; yy < y1; ++yy)
            {
                uint8_t* row = data + (yy * strideBytes) + x0 * 4;
                for (int32_t xx = x0; xx < x1; ++xx)
                {
                    row[0] = sr; row[1] = sg; row[2] = sb; row[3] = 255;
                    row += 4;
                }
            }
            return;
        }

        // src-over: out = src + dst * (1 - src.a)
        const int32_t inv = 255 - sa;
        for (int32_t yy = y0; yy < y1; ++yy)
        {
            uint8_t* row = data + (yy * strideBytes) + x0 * 4;
            for (int32_t xx = x0; xx < x1; ++xx)
            {
                const int32_t dr = row[0];
                const int32_t dg = row[1];
                const int32_t db = row[2];
                row[0] = static_cast<uint8_t>((sr * sa + dr * inv) / 255);
                row[1] = static_cast<uint8_t>((sg * sa + dg * inv) / 255);
                row[2] = static_cast<uint8_t>((sb * sa + db * inv) / 255);
                row[3] = 255;
                row += 4;
            }
        }
    }

    // Stroked rect: four edge rects (top, bottom, left, right). Lines drawn
    // inside the (x, y, W, H) box so the stroke doesn't extend outward.
    void strokeRect(int32_t x, int32_t y, int32_t W, int32_t H,
                    int32_t lineWidth, uint32_t rgba)
    {
        if (lineWidth <= 0 || W <= 0 || H <= 0) { return; }
        const int32_t lw = std::min(lineWidth, std::min(W, H));
        // Top + bottom edges
        fillRect(x,             y,                 W,  lw, rgba);
        fillRect(x,             y + H - lw,        W,  lw, rgba);
        // Left + right edges (corners already covered by top/bottom)
        fillRect(x,             y + lw,            lw, H - 2 * lw, rgba);
        fillRect(x + W - lw,    y + lw,            lw, H - 2 * lw, rgba);
    }
};
