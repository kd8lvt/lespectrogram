#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>

#include "AudioBuffer.hpp"

// Computes a min/max envelope of an AudioBuffer slice for waveform display.
// Output layout in the scratch region: pairs of (min, max) per pixel column.
// Caller picks the pixel count at compute time, up to MAX_PIXELS.
class WaveInterpolator
{
public:
    static constexpr int32_t MAX_PIXELS = 4096;

    // Envelope of a slice [startFrame, startFrame + lengthFrames) of the
    // buffer, mapped to `pixels` columns. `channels` overrides the buffer's
    // channel count for cases where a region was recorded with a different
    // channel layout. `gain` pre-multiplies the output and clamps to ±1 so
    // the renderer can blit values directly without further scaling.
    void computeRange(const AudioBuffer& buffer,
                      const int32_t startFrame,
                      int32_t lengthFrames,
                      const int32_t channels,
                      int32_t pixels,
                      const float gain = 1.0f)
    {
        pixels = std::clamp(pixels, 0, MAX_PIXELS);
        if (pixels == 0)
        {
            return;
        }

        const size_t outBytes = static_cast<size_t>(pixels) * 2 * sizeof(float);
        if (lengthFrames <= 0 || channels <= 0 || startFrame < 0)
        {
            std::memset(scratch, 0, outBytes);
            return;
        }

        lengthFrames = std::min(lengthFrames, AudioBuffer::MAX_FRAMES - startFrame);
        if (lengthFrames <= 0)
        {
            std::memset(scratch, 0, outBytes);
            return;
        }

        const float*  samples     = buffer.data() + startFrame * channels;
        const float   invChannels = 1.0f / static_cast<float>(channels);
        const int64_t len64       = static_cast<int64_t>(lengthFrames);
        const int64_t pix64       = static_cast<int64_t>(pixels);

        for (int32_t x = 0; x < pixels; ++x)
        {
            // Integer math so the last pixel is exactly lengthFrames; using
            // int64 prevents overflow on long captures with high pixel counts.
            int32_t s0 = static_cast<int32_t>((static_cast<int64_t>(x)     * len64) / pix64);
            int32_t s1 = std::min(
                static_cast<int32_t>((static_cast<int64_t>(x + 1) * len64) / pix64),
                lengthFrames);
            if (s0 >= s1)
            {
                // Empty range (more pixels than frames). Repeat the nearest
                // sample so the wave visibly extends rather than reading 0.
                s0 = (s1 > 0) ? s1 - 1 : 0;
            }

            float first = 0.0f;
            for (int32_t c = 0; c < channels; ++c) first += samples[s0 * channels + c];
            first *= invChannels;
            float mn = first, mx = first;

            for (int32_t i = s0 + 1; i < s1; ++i)
            {
                float s = 0.0f;
                for (int32_t c = 0; c < channels; ++c) s += samples[i * channels + c];
                s *= invChannels;
                mn = std::min(mn, s);
                mx = std::max(mx, s);
            }

            scratch[x * 2]     = std::clamp(mn * gain, -1.0f, 1.0f);
            scratch[x * 2 + 1] = std::clamp(mx * gain, -1.0f, 1.0f);
        }
    }

    const float* output() const { return scratch; }

private:
    alignas(16) float scratch[MAX_PIXELS * 2]{};
};
