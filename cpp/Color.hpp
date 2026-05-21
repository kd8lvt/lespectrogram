#pragma once

#include <cstdint>

// RGBA8888 packed as 0xRRGGBBAA. Single source of truth for the byte order
// used across PixelBuffer, WaveformRenderer, and the C++→JS color int the
// drawlist emits for text commands.

namespace color
{

constexpr uint32_t pack(int r, int g, int b, int a)
{
    return (static_cast<uint32_t>(r) << 24)
         | (static_cast<uint32_t>(g) << 16)
         | (static_cast<uint32_t>(b) << 8)
         |  static_cast<uint32_t>(a);
}

inline void unpack(uint32_t rgba, uint8_t& r, uint8_t& g, uint8_t& b, uint8_t& a)
{
    r = static_cast<uint8_t>((rgba >> 24) & 0xFF);
    g = static_cast<uint8_t>((rgba >> 16) & 0xFF);
    b = static_cast<uint8_t>((rgba >>  8) & 0xFF);
    a = static_cast<uint8_t>( rgba        & 0xFF);
}

}  // namespace color
