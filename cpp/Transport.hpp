#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>

#include "AudioBuffer.hpp"
#include "Region.hpp"

// Memory-mapped transport state. JS reads / writes directly via typed-array
// views over shared memory at known i32 offsets — no per-field WASM call.
//
//   index   field
//     0     state             (atomic i32: 0 IDLE / 1 PLAYING / 2 RECORDING)
//     1     pos               (atomic i32: track position in frames)
//     2     tapeWriteHead     (atomic i32)
//     3     currentRegionId   (atomic i32: -1 unless RECORDING)
//     4     selectedRegionId  (atomic i32; main thread only, but atomic for safety)
//     5     loopEnabled       (atomic i32)
//     6     rangeStart        (atomic i32; -1 = none)
//     7     rangeEnd          (atomic i32; -1 = none)
//     8     channels          (i32, init-only)
//     9     sampleRate        (i32, init-only)
//    10..11 pad
//    12     displayGain       (f32; main-thread only)
//    13..15 pad
struct alignas(8) TransportStateView
{
    std::atomic<int32_t> state;
    std::atomic<int32_t> pos;
    std::atomic<int32_t> tapeWriteHead;
    std::atomic<int32_t> currentRegionId;

    std::atomic<int32_t> selectedRegionId;
    std::atomic<int32_t> loopEnabled;
    std::atomic<int32_t> rangeStart;
    std::atomic<int32_t> rangeEnd;

    int32_t channels;
    int32_t sampleRate;
    std::atomic<int32_t> scrollOffsetFrames; // [10] left edge of view in frames
    int32_t _pad0; // [11]

    float displayGain; // [12]
    float displayZoom; // [13] 1.0 = fit-to-width
    float _pad1[2]; // [14-15]
};

static_assert(sizeof(TransportStateView) == 64, "TransportStateView must be 64 bytes");

class Transport
{
public:
    enum State : int32_t
    {
        STATE_IDLE = 0,
        STATE_PLAYING = 1,
        STATE_RECORDING = 2,
    };

    Transport(AudioBuffer& buf, TrackRegions& rgn, TransportStateView& v)
        : buffer(buf), regions(rgn), view(v)
    {
    }

    void play() const
    {
        // Snap to loop start on idle→play (or recording→play) when looping is
        // armed with a valid range. Restarting while already PLAYING is left
        // alone so the JS-side "restart from 0" path stays predictable.
        const int32_t prevState = view.state.load(std::memory_order_acquire);
        if (prevState != STATE_PLAYING
            && view.loopEnabled.load(std::memory_order_acquire))
        {
            // End-first range read (see setRange / processPlaying).
            const int32_t rEnd   = view.rangeEnd  .load(std::memory_order_seq_cst);
            const int32_t rStart = view.rangeStart.load(std::memory_order_relaxed);
            if (rStart >= 0 && rEnd > rStart)
            {
                view.pos.store(rStart, std::memory_order_seq_cst);
            }
        }
        view.currentRegionId.store(-1, std::memory_order_release);
        view.state.store(STATE_PLAYING, std::memory_order_release);
    }

    void stop() const
    {
        view.currentRegionId.store(-1, std::memory_order_release);
        view.state.store(STATE_IDLE, std::memory_order_release);
    }

    int32_t record() const
    {
        const int32_t startFrame = view.pos.load(std::memory_order_seq_cst);
        const int32_t writeHead = view.tapeWriteHead.load(std::memory_order_acquire);
        const int32_t id = regions.add(startFrame, writeHead, 0, view.channels);
        if (id < 0) return -1;
        view.currentRegionId.store(id, std::memory_order_release);
        view.state.store(STATE_RECORDING, std::memory_order_release);
        return id;
    }

    void setPos(int32_t frame) const
    {
        if (frame < 0) frame = 0;
        view.pos.store(frame, std::memory_order_seq_cst);
    }

    void setRange(const int32_t startFrame, const int32_t endFrame) const
    {
        // End-first publish: writer stores rangeStart (relaxed) then rangeEnd
        // (seq_cst). Readers must load rangeEnd first (seq_cst) then
        // rangeStart (relaxed). The protocol relies on these two stores being
        // adjacent — do not interleave other state here.
        if (startFrame < 0 || endFrame < 0 || endFrame <= startFrame)
        {
            view.rangeStart.store(-1, std::memory_order_relaxed);
            view.rangeEnd  .store(-1, std::memory_order_seq_cst);
            return;
        }
        view.rangeStart.store(startFrame, std::memory_order_relaxed);
        view.rangeEnd  .store(endFrame,   std::memory_order_seq_cst);
    }

    void process(const float* scratchIn,
                 float* scratchOut,
                 const int32_t frames)
    {
        const int32_t outputChannels = view.channels;
        const size_t  outBytes       = static_cast<size_t>(frames) * outputChannels * sizeof(float);
        const int32_t s              = view.state.load(std::memory_order_acquire);

        if (s == STATE_RECORDING)
        {
            processRecording(scratchIn, scratchOut, frames, outputChannels, outBytes);
            return;
        }
        if (s == STATE_PLAYING)
        {
            processPlaying(scratchOut, frames, outputChannels, outBytes);
            return;
        }
        std::memset(scratchOut, 0, outBytes);
    }

private:
    void processRecording(const float* scratchIn,
                          float* scratchOut,
                          const int32_t frames,
                          const int32_t outputChannels,
                          const size_t outBytes) const
    {
        const int32_t id = view.currentRegionId.load(std::memory_order_acquire);
        if (id < 0)
        {
            std::memset(scratchOut, 0, outBytes);
            return;
        }
        Region& r = regions.get(id);
        const int32_t curLen = r.lengthFrames.load(std::memory_order_relaxed);
        const int32_t bufOff = r.bufferOffsetFrames;
        const int32_t regCh = r.channels;
        constexpr int32_t cap = AudioBuffer::MAX_FRAMES;

        int32_t framesToWrite = frames;
        if (bufOff + curLen + framesToWrite > cap)
        {
            framesToWrite = cap - bufOff - curLen;
            if (framesToWrite < 0) framesToWrite = 0;
        }

        if (framesToWrite > 0)
        {
            float* dst = buffer.data() + (bufOff + curLen) * regCh;
            std::memcpy(dst, scratchIn,
                        static_cast<size_t>(framesToWrite) * regCh * sizeof(float));
            r.lengthFrames.store(curLen + framesToWrite, std::memory_order_release);
            view.tapeWriteHead.store(bufOff + curLen + framesToWrite,
                                     std::memory_order_release);
            view.pos.fetch_add(framesToWrite, std::memory_order_seq_cst);
        }

        std::memcpy(scratchOut, scratchIn, outBytes);

        if (framesToWrite < frames)
        {
            view.state.store(STATE_IDLE, std::memory_order_release);
            view.currentRegionId.store(-1, std::memory_order_release);
        }
    }

    void processPlaying(float* scratchOut,
                        const int32_t frames,
                        const int32_t outputChannels,
                        const size_t outBytes) const
    {
        int32_t pos = view.pos.load(std::memory_order_seq_cst);
        const int32_t total = regions.trackLength();
        if (total <= 0)
        {
            std::memset(scratchOut, 0, outBytes);
            view.state.store(STATE_IDLE, std::memory_order_release);
            return;
        }

        // End-first protocol (paired with setRange/Gestures range writers):
        // load rangeEnd seq_cst, then rangeStart relaxed. If we see a new
        // rangeEnd we are guaranteed to see the matching new rangeStart.
        const int32_t loopOn = view.loopEnabled.load(std::memory_order_acquire);
        const int32_t rEnd   = view.rangeEnd  .load(std::memory_order_seq_cst);
        const int32_t rStart = view.rangeStart.load(std::memory_order_relaxed);
        const bool looping = loopOn && rStart >= 0 && rEnd > rStart;

        const float* src = buffer.data();

        for (int32_t i = 0; i < frames; ++i)
        {
            if (looping && pos >= rEnd) pos = rStart;

            if (pos >= total)
            {
                std::memset(&scratchOut[i * outputChannels], 0,
                            static_cast<size_t>(frames - i) * outputChannels * sizeof(float));
                view.state.store(STATE_IDLE, std::memory_order_release);
                view.pos.store(pos, std::memory_order_seq_cst);
                return;
            }

            const int32_t rid = regions.findCovering(pos);
            if (rid < 0)
            {
                for (int32_t c = 0; c < outputChannels; ++c)
                {
                    scratchOut[i * outputChannels + c] = 0.0f;
                }
            }
            else
            {
                const Region& r = regions.get(rid);
                const int32_t rStartFrame = r.trackStartFrame.load(std::memory_order_acquire);
                const int32_t local = pos - rStartFrame;
                const int32_t srcIdx = (r.bufferOffsetFrames + local) * r.channels;
                for (int32_t c = 0; c < outputChannels; ++c)
                {
                    const int32_t srcCh = (c < r.channels) ? c : 0;
                    scratchOut[i * outputChannels + c] = src[srcIdx + srcCh];
                }
            }
            ++pos;
        }
        view.pos.store(pos, std::memory_order_seq_cst);
    }

    AudioBuffer& buffer;
    TrackRegions& regions;
    TransportStateView& view;
};
