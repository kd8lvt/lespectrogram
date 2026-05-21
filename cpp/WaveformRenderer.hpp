#pragma once

#include <algorithm>
#include <cstdint>

#include "AudioBuffer.hpp"
#include "Region.hpp"
#include "Transport.hpp"
#include "WaveInterpolator.hpp"
#include "DrawList.hpp"
#include "PixelBuffer.hpp"
#include "Color.hpp"

namespace render_detail
{

// Thin shim — the encoding lives in Color.hpp. Kept here only so the many
// existing render_detail::packRgba(...) call sites don't all need editing.
inline uint32_t packRgba(int r, int g, int b, int a)
{
    return color::pack(r, g, b, a);
}

// h in [0, 360), s/l/a in [0, 1].
inline uint32_t hsla(float h, float s, float l, float a)
{
    auto hueToRgb = [](float p, float q, float t) -> float
    {
        if (t < 0.0f) { t += 1.0f; }
        if (t > 1.0f) { t -= 1.0f; }
        if (t < 1.0f / 6.0f) { return p + (q - p) * 6.0f * t; }
        if (t < 1.0f / 2.0f) { return q; }
        if (t < 2.0f / 3.0f) { return p + (q - p) * (2.0f / 3.0f - t) * 6.0f; }
        return p;
    };

    float r, g, b;
    if (s <= 0.0f)
    {
        r = g = b = l;
    }
    else
    {
        const float q  = (l < 0.5f) ? l * (1.0f + s) : l + s - l * s;
        const float p  = 2.0f * l - q;
        const float hh = h / 360.0f;
        r = hueToRgb(p, q, hh + 1.0f / 3.0f);
        g = hueToRgb(p, q, hh);
        b = hueToRgb(p, q, hh - 1.0f / 3.0f);
    }
    return packRgba(
        static_cast<int>(std::clamp(r, 0.0f, 1.0f) * 255.0f + 0.5f),
        static_cast<int>(std::clamp(g, 0.0f, 1.0f) * 255.0f + 0.5f),
        static_cast<int>(std::clamp(b, 0.0f, 1.0f) * 255.0f + 0.5f),
        static_cast<int>(std::clamp(a, 0.0f, 1.0f) * 255.0f + 0.5f));
}

inline float regionHue(int32_t id)
{
    float h = static_cast<float>(id) * 137.508f;
    while (h >= 360.0f) { h -= 360.0f; }
    while (h <    0.0f) { h += 360.0f; }
    return h;
}

// Format `seconds` as "M:SS.ss" if >= 1 minute, else "S.SSs". Returns bytes
// written. Manual formatting to avoid pulling in <cstdio>.
inline int32_t formatRulerTime(float seconds, char* out, int32_t cap)
{
    if (!(seconds >= 0.0f)) { seconds = 0.0f; }
    int32_t mins = static_cast<int32_t>(seconds / 60.0f);
    float   s    = seconds - mins * 60.0f;
    int32_t len  = 0;

    auto writeNum = [&](int v, int minDigits)
    {
        char digs[11];
        int  d = 0;
        if (v <= 0)
        {
            digs[d++] = '0';
        }
        else
        {
            int x = v;
            while (x > 0 && d < 11)
            {
                digs[d++] = '0' + (x % 10);
                x /= 10;
            }
        }
        while (d < minDigits && d < 11) { digs[d++] = '0'; }
        while (d > 0 && len < cap)      { out[len++] = digs[--d]; }
    };

    if (mins > 0)
    {
        writeNum(mins, 1);
        if (len < cap) { out[len++] = ':'; }
        int wholes     = static_cast<int>(s);
        int hundredths = static_cast<int>((s - wholes) * 100.0f + 0.5f);
        if (hundredths >= 100)
        {
            wholes++;
            hundredths -= 100;
        }
        writeNum(wholes, 2);
        if (len < cap) { out[len++] = '.'; }
        writeNum(hundredths, 2);
    }
    else
    {
        int wholes     = static_cast<int>(s);
        int hundredths = static_cast<int>((s - wholes) * 100.0f + 0.5f);
        if (hundredths >= 100)
        {
            wholes++;
            hundredths -= 100;
        }
        writeNum(wholes, 1);
        if (len < cap) { out[len++] = '.'; }
        writeNum(hundredths, 2);
        if (len < cap) { out[len++] = 's'; }
    }
    return len;
}

inline float pickTickStep(float totalSeconds)
{
    constexpr float candidates[] = {
        0.05f, 0.1f, 0.25f, 0.5f, 1.0f, 2.0f, 5.0f,
        10.0f, 15.0f, 30.0f, 60.0f, 120.0f, 300.0f
    };
    const float target = totalSeconds / 8.0f;
    for (float c : candidates)
    {
        if (c >= target) { return c; }
    }
    return candidates[12];
}

}  // namespace render_detail

class WaveformRenderer
{
public:
    static constexpr int32_t RULER_H_CSS              = 24;
    static constexpr int32_t LABEL_H_CSS              = 16;
    static constexpr int32_t TIMELINE_DEFAULT_SECONDS = 300;

    void render(DrawList&    list,
                PixelBuffer& pixels,
                TransportStateView& state,
                TrackRegions&       regions,
                const AudioBuffer&  buffer,
                WaveInterpolator&   interp,
                const int32_t Wphys,
                const int32_t Hphys,
                const float   dpr)
    {
        list.reset();
        pixels.begin(Wphys, Hphys);

        const int32_t rulerHpx = static_cast<int32_t>(RULER_H_CSS * dpr + 0.5f);
        const int32_t labelHpx = static_cast<int32_t>(LABEL_H_CSS * dpr + 0.5f);
        const int32_t fontPx   = static_cast<int32_t>(11.0f       * dpr + 0.5f);

        // Background
        pixels.clear(render_detail::packRgba(0x1A, 0x1A, 0x1A, 0xFF));

        const int32_t trackLen   = regions.trackLength();
        const int32_t sampleRate = state.sampleRate;
        if (sampleRate <= 0) { return; }

        const int64_t timelineFloor = static_cast<int64_t>(TIMELINE_DEFAULT_SECONDS) * sampleRate;
        const int32_t timelineLen   = (trackLen > timelineFloor)
                                          ? trackLen
                                          : static_cast<int32_t>(timelineFloor);
        if (timelineLen <= 0) { return; }

        // NaN guard via `!(x >= 1.0f)` — std::clamp would propagate NaN.
        float zoom = state.displayZoom;
        if (!(zoom >= 1.0f)) { zoom = 1.0f; }
        if (zoom > 64.0f)    { zoom = 64.0f; }
        const int32_t visibleFrames = static_cast<int32_t>(timelineLen / zoom);

        // Auto-scroll during playback: if the playhead leaves the visible
        // window while zoomed in, jump scroll so the head sits ~10% from the
        // left edge of the new view.
        if (state.state.load(std::memory_order_acquire) == Transport::STATE_PLAYING
            && zoom > 1.0f && visibleFrames > 0)
        {
            const int32_t off = state.scrollOffsetFrames.load(std::memory_order_acquire);
            const int32_t pos = state.pos.load(std::memory_order_seq_cst);
            if (pos < off || pos >= off + visibleFrames)
            {
                const int32_t newOff = std::max(0, pos - visibleFrames / 10);
                state.scrollOffsetFrames.store(newOff, std::memory_order_release);
            }
        }

        const int32_t scrollOffset = state.scrollOffsetFrames.load(std::memory_order_acquire);

        auto frameToX = [&](int32_t frame) -> int32_t
        {
            if (visibleFrames <= 0) { return 0; }
            return static_cast<int32_t>(
                (static_cast<double>(frame - scrollOffset) / visibleFrames) * Wphys + 0.5);
        };

        renderRuler(list, pixels, Wphys, rulerHpx, scrollOffset, visibleFrames, sampleRate, dpr, fontPx);

        const int32_t selectedId = state.selectedRegionId.load(std::memory_order_acquire);
        const int32_t trackTop   = rulerHpx;
        const int32_t trackH     = Hphys - trackTop;
        const int32_t waveTop    = trackTop + labelHpx;
        const int32_t waveH      = trackH - labelHpx;
        const int32_t midY       = waveTop + waveH / 2;
        const float   ampY       = waveH * 0.46f;

        if (trackLen > 0)
        {
            const int32_t numRegions = regions.count();
            for (int32_t id = 0; id < numRegions; ++id)
            {
                const Region& r = regions.get(id);
                if (r.active.load(std::memory_order_acquire) == 0) { continue; }
                const int32_t rLen = r.lengthFrames.load(std::memory_order_acquire);
                if (rLen <= 0) { continue; }
                const int32_t rStart = r.trackStartFrame.load(std::memory_order_acquire);

                const int32_t xStart = frameToX(rStart);
                const int32_t xEnd   = frameToX(rStart + rLen);
                if (xEnd < 0 || xStart > Wphys) { continue; }
                const int32_t regionW = xEnd - xStart;
                if (regionW < 1) { continue; }

                const float hue        = render_detail::regionHue(id);
                const bool  isSelected = id == selectedId;

                // Wave area background
                pixels.fillRect(xStart, waveTop, regionW, waveH,
                    isSelected ? render_detail::hsla(hue, 0.70f, 0.38f, 0.70f)
                               : render_detail::hsla(hue, 0.55f, 0.28f, 0.55f));

                // Label bar
                pixels.fillRect(xStart, trackTop, regionW, labelHpx,
                    isSelected ? render_detail::hsla(hue, 0.75f, 0.30f, 1.00f)
                               : render_detail::hsla(hue, 0.55f, 0.22f, 0.95f));

                // Border (thicker when selected)
                const int32_t bw = isSelected
                    ? std::max(2, static_cast<int32_t>(2 * dpr + 0.5f))
                    : 1;
                pixels.strokeRect(xStart, trackTop, regionW, trackH, bw,
                    isSelected ? render_detail::hsla(hue, 0.90f, 0.78f, 1.0f)
                               : render_detail::hsla(hue, 0.60f, 0.50f, 0.9f));

                // Label text (vertically centered within label bar)
                const int32_t labelLen = r.labelLen.load(std::memory_order_acquire);
                if (labelLen > 0 && regionW > 8)
                {
                    const char*   labelStr = regions.labelsPtr() + id * TrackRegions::MAX_LABEL;
                    const int32_t labelY   = trackTop + (labelHpx - fontPx) / 2;
                    list.fillText(xStart + 4, labelY, fontPx, /*align=left*/ 0,
                                  render_detail::packRgba(0xFF, 0xFF, 0xFF, 0xFF),
                                  labelStr, labelLen);
                }

                // Wave bars (one fillRect per pixel column).
                const int32_t px = std::min(regionW, WaveInterpolator::MAX_PIXELS);
                interp.computeRange(buffer, r.bufferOffsetFrames, rLen, r.channels,
                                    px, state.displayGain);
                const float* env = interp.output();

                const uint32_t waveColor = isSelected
                    ? render_detail::hsla(hue, 0.95f, 0.92f, 0.98f)
                    : render_detail::hsla(hue, 0.75f, 0.78f, 0.95f);

                for (int32_t i = 0; i < px; ++i)
                {
                    const float   mn  = env[i * 2];
                    const float   mx  = env[i * 2 + 1];
                    const int32_t yMx = static_cast<int32_t>(midY - mx * ampY);
                    const int32_t yMn = static_cast<int32_t>(midY - mn * ampY);
                    const int32_t hh  = std::max(1, yMn - yMx);
                    pixels.fillRect(xStart + i, yMx, 1, hh, waveColor);
                }
            }

            // Wave-area centerline (~10% white)
            pixels.fillRect(0, midY, Wphys, 1,
                            render_detail::packRgba(0xFF, 0xFF, 0xFF, 0x1A));

            // Range overlay
            const int32_t rangeStart = state.rangeStart.load(std::memory_order_acquire);
            const int32_t rangeEnd   = state.rangeEnd.load(std::memory_order_acquire);
            if (rangeStart >= 0 && rangeEnd > rangeStart)
            {
                const int32_t xR0 = frameToX(rangeStart);
                const int32_t xR1 = frameToX(rangeEnd);
                if (xR1 > 0 && xR0 < Wphys)
                {
                    const int32_t x0 = std::max(0,     xR0);
                    const int32_t x1 = std::min(Wphys, xR1);
                    pixels.fillRect(x0, trackTop, x1 - x0, trackH,
                                    render_detail::packRgba(0xFF, 0xDC, 0x00, 0x2E));
                    if (xR0 >= 0 && xR0 < Wphys)
                    {
                        pixels.fillRect(xR0, trackTop, 1, trackH,
                                        render_detail::packRgba(0xFF, 0xDC, 0x00, 0xD9));
                    }
                    if (xR1 > 0 && xR1 <= Wphys)
                    {
                        pixels.fillRect(xR1 - 1, trackTop, 1, trackH,
                                        render_detail::packRgba(0xFF, 0xDC, 0x00, 0xD9));
                    }
                }
            }
        }

        // Playhead
        const int32_t pos = state.pos.load(std::memory_order_seq_cst);
        const int32_t phX = frameToX(pos);
        if (phX >= 0 && phX < Wphys)
        {
            const int32_t lw = std::max(2, static_cast<int32_t>(2 * dpr + 0.5f));
            pixels.fillRect(phX, 0, lw, Hphys,
                            render_detail::packRgba(0xFF, 0x50, 0x50, 0xFF));
        }
    }

private:
    void renderRuler(DrawList&     list,
                     PixelBuffer&  pixels,
                     const int32_t Wphys,
                     const int32_t rulerHpx,
                     const int32_t offset,
                     const int32_t visible,
                     const int32_t sampleRate,
                     const float   dpr,
                     const int32_t fontPx)
    {
        pixels.fillRect(0, 0, Wphys, rulerHpx,
                        render_detail::packRgba(0x22, 0x22, 0x22, 0xFF));
        pixels.fillRect(0, rulerHpx - 1, Wphys, 1,
                        render_detail::packRgba(0xFF, 0xFF, 0xFF, 0x14));

        if (sampleRate <= 0 || visible <= 0) { return; }

        const float startSec = offset  / static_cast<float>(sampleRate);
        const float visSec   = visible / static_cast<float>(sampleRate);
        const float step     = render_detail::pickTickStep(visSec);

        const int32_t  tickH     = static_cast<int32_t>(6 * dpr + 0.5f);
        const uint32_t tickColor = render_detail::packRgba(0xFF, 0xFF, 0xFF, 0x80);
        const uint32_t textColor = render_detail::packRgba(0xBB, 0xBB, 0xBB, 0xFF);

        // First tick at or after startSec.
        float t = static_cast<int32_t>(startSec / step) * step;
        if (t < startSec) { t += step; }

        const float   endSec = startSec + visSec;
        const int32_t edgePx = static_cast<int32_t>(24 * dpr + 0.5f);
        char timeBuf[16];

        for (; t <= endSec + 1e-5f; t += step)
        {
            const int32_t x = static_cast<int32_t>(((t - startSec) / visSec) * Wphys + 0.5f);
            pixels.fillRect(x, rulerHpx - tickH, 1, tickH, tickColor);

            const int32_t align = (x < edgePx)            ? 0   // left
                                : (x > Wphys - edgePx)    ? 2   // right
                                                          : 1;  // center
            const int32_t len = render_detail::formatRulerTime(t, timeBuf, 16);
            list.fillText(x, static_cast<int32_t>(3 * dpr + 0.5f),
                          fontPx, align, textColor, timeBuf, len);
        }
    }
};
