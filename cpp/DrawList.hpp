#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>

// Fixed-stride drawlist. Text-only since rect rendering moved into
// PixelBuffer (blitted as a single putImageData on the JS side). The
// stride and slot layout are preserved so the JS-side Int32Array view
// doesn't need its parser specialised on a different shape.
//
//   slot   field
//   [0]    type (3 = CMD_FILL_TEXT — only emitted value)
//   [1]    x
//   [2]    y
//   [3]    fontSizePx
//   [4]    align (0 = L, 1 = C, 2 = R)
//   [5]    color (0xRRGGBBAA packed)
//   [6]    textOffset (into text[])
//   [7]    textLength
//
// Coordinates are in physical canvas pixels (caller has scaled by dpr).
struct DrawList
{
    static constexpr int32_t MAX_CMDS       = 4096;
    static constexpr int32_t TEXT_BYTES     = 16384;
    static constexpr int32_t CMD_STRIDE_I32 = 8;

    enum CmdType : int32_t
    {
        CMD_FILL_TEXT = 3,
    };

    int32_t cmds[MAX_CMDS * CMD_STRIDE_I32];
    char    text[TEXT_BYTES];
    int32_t count   = 0;
    int32_t textOff = 0;

    void reset() { count = 0; textOff = 0; }

    int32_t* allocSlot()
    {
        if (count >= MAX_CMDS)
        {
            return nullptr;
        }
        int32_t* s = cmds + count * CMD_STRIDE_I32;
        ++count;
        return s;
    }

    void fillText(int32_t x, int32_t y, int32_t fontSizePx, int32_t align,
                  uint32_t color, const char* str, int32_t len)
    {
        len = std::max(0, len);
        if (textOff + len > TEXT_BYTES)
        {
            return;
        }
        int32_t* s = allocSlot();
        if (!s)
        {
            return;
        }
        s[0] = CMD_FILL_TEXT;
        s[1] = x; s[2] = y; s[3] = fontSizePx; s[4] = align;
        s[5] = static_cast<int32_t>(color);
        s[6] = textOff; s[7] = len;
        std::memcpy(text + textOff, str, len);
        textOff += len;
    }
};
