#pragma once

#include <cstdint>

class AudioBuffer
{
public:
    static constexpr int32_t MAX_FRAMES = 5 * 60 * 48000; // 5 min @ 48 kHz
    static constexpr int32_t MAX_CHANNELS = 2;

    void load(int32_t frames, int32_t channels, int32_t /*sampleRate*/)
    {
        if (frames < 0) frames = 0;
        if (frames > MAX_FRAMES) frames = MAX_FRAMES;
        if (channels < 1) channels = 1;
        if (channels > MAX_CHANNELS) channels = MAX_CHANNELS;
        loadedFrames = frames;
        loadedChannels = channels;
    }

    float* data() { return samples; }
    const float* data() const { return samples; }
    int32_t frameCount() const { return loadedFrames; }
    int32_t channelCount() const { return loadedChannels; }
    static constexpr int32_t capacityFrames() { return MAX_FRAMES; }

private:
    alignas(16) float samples[MAX_FRAMES * MAX_CHANNELS]{};
    int32_t loadedFrames = 0;
    int32_t loadedChannels = 0;
};
