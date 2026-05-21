#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>

// Imported from JS: returns Date.now() in milliseconds since Unix epoch.
// clang-format off
extern "C" double app_now_ms(void) __attribute__((import_module("env"), import_name("app_now_ms")));
// clang-format on

namespace region_detail
{
    // Writes "Region<N>" into `out` (length-bounded by `cap`). Returns bytes written.
    // Manual formatting avoids dragging in <cstdio>/snprintf and its friends
    // (which pull printf format machinery + thread-local hooks).
    inline int32_t writeDefaultLabel(int32_t n, char* out, int32_t cap)
    {
        constexpr const char prefix[] = "Region";
        int32_t len = 0;
        for (int32_t i = 0; i < 6 && len < cap; ++i) out[len++] = prefix[i];

        char digits[11];
        int32_t d = 0;
        if (n <= 0)
        {
            digits[d++] = '0';
        }
        else
        {
            int32_t v = n;
            while (v > 0 && d < 11)
            {
                digits[d++] = static_cast<char>('0' + (v % 10));
                v /= 10;
            }
        }
        while (d > 0 && len < cap) out[len++] = digits[--d];
        return len;
    }
} // namespace region_detail

// Region scalars in a fixed 64-byte (16 i32) layout so JS can read them
// directly out of shared memory via an Int32Array view. Field order is part of
// the ABI; do not reorder without bumping a version field.
//
//   index   field
//     0     trackStartFrame   (atomic i32)
//     1     bufferOffsetFrames(i32, immutable)
//     2     lengthFrames      (atomic i32)
//     3     active            (atomic i32)
//     4     channels          (i32, immutable)
//     5     labelLen          (atomic i32)
//     6,7   pad (align slug to 8 bytes)
//     8,9   slug              (f64; Unix epoch ms)
//   10..15  pad (align to 64 bytes)
struct alignas(8) Region
{
    std::atomic<int32_t> trackStartFrame;
    int32_t bufferOffsetFrames;
    std::atomic<int32_t> lengthFrames;
    std::atomic<int32_t> active;
    int32_t channels;
    std::atomic<int32_t> labelLen;
    int32_t _pad0[2];
    double slug;
    int32_t _pad1[6];
};

static_assert(sizeof(Region) == 64, "Region must be 64 bytes");

class TrackRegions
{
public:
    static constexpr int32_t MAX_REGIONS = 32;
    static constexpr int32_t MAX_LABEL = 32;

    int32_t count() const { return numRegions.load(std::memory_order_acquire); }

    // Adds a region with auto-generated label "Region{N}" and slug = app_now_ms().
    // Returns id, or -1 if full.
    int32_t add(int32_t trackStart, int32_t bufferOffset, int32_t length, int32_t ch)
    {
        const int32_t cur = numRegions.load(std::memory_order_relaxed);
        if (cur >= MAX_REGIONS) return -1;
        Region& r = items[cur];
        r.trackStartFrame.store(trackStart, std::memory_order_relaxed);
        r.bufferOffsetFrames = bufferOffset;
        r.channels = ch;
        r.lengthFrames.store(length, std::memory_order_relaxed);
        r.slug = app_now_ms();

        // Default label "Region{N}". JS may overwrite (e.g. with filename).
        const int32_t labelLen = region_detail::writeDefaultLabel(cur + 1, labels[cur], MAX_LABEL);
        r.labelLen.store(labelLen, std::memory_order_relaxed);

        r.active.store(1, std::memory_order_release);
        numRegions.store(cur + 1, std::memory_order_release);
        return cur;
    }

    void deactivate(int32_t id)
    {
        if (id < 0 || id >= numRegions.load(std::memory_order_relaxed)) return;
        items[id].active.store(0, std::memory_order_release);
    }

    void clearAll()
    {
        const int32_t n = numRegions.load(std::memory_order_relaxed);
        for (int32_t i = 0; i < n; ++i)
        {
            items[i].active.store(0, std::memory_order_relaxed);
            items[i].lengthFrames.store(0, std::memory_order_relaxed);
            items[i].trackStartFrame.store(0, std::memory_order_relaxed);
            items[i].labelLen.store(0, std::memory_order_relaxed);
            items[i].slug = 0.0;
        }
        numRegions.store(0, std::memory_order_release);
    }

    Region& get(int32_t id) { return items[id]; }
    const Region& get(int32_t id) const { return items[id]; }

    Region* itemsPtr() { return items; }
    char* labelsPtr() { return &labels[0][0]; }

    // Set the label for region `id` from the first `len` bytes of `buf`.
    void setLabel(int32_t id, const char* buf, int32_t len)
    {
        if (id < 0 || id >= numRegions.load(std::memory_order_relaxed)) return;
        if (len < 0) len = 0;
        if (len > MAX_LABEL) len = MAX_LABEL;
        std::memcpy(labels[id], buf, len);
        items[id].labelLen.store(len, std::memory_order_release);
    }

    int32_t findCovering(int32_t frame) const
    {
        const int32_t n = numRegions.load(std::memory_order_acquire);
        for (int32_t i = n - 1; i >= 0; --i)
        {
            const Region& r = items[i];
            if (r.active.load(std::memory_order_acquire) == 0) continue;
            const int32_t start = r.trackStartFrame.load(std::memory_order_acquire);
            const int32_t len = r.lengthFrames.load(std::memory_order_acquire);
            if (frame >= start && frame < start + len) return i;
        }
        return -1;
    }

    int32_t trackLength() const
    {
        const int32_t n = numRegions.load(std::memory_order_acquire);
        int32_t maxEnd = 0;
        for (int32_t i = 0; i < n; ++i)
        {
            const Region& r = items[i];
            if (r.active.load(std::memory_order_acquire) == 0) continue;
            const int32_t start = r.trackStartFrame.load(std::memory_order_acquire);
            const int32_t len = r.lengthFrames.load(std::memory_order_acquire);
            const int32_t end = start + len;
            if (end > maxEnd) maxEnd = end;
        }
        return maxEnd;
    }

private:
    Region items[MAX_REGIONS];
    char labels[MAX_REGIONS][MAX_LABEL];
    std::atomic<int32_t> numRegions{0};
};
