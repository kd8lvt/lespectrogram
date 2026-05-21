#pragma once

#include <algorithm>
#include <cstdint>
#include <utility>

#include "Region.hpp"
#include "Transport.hpp"

namespace gestures
{

constexpr int32_t RULER_H_CSS              = 24;
constexpr int32_t LABEL_H_CSS              = 16;
constexpr int32_t TIMELINE_DEFAULT_SECONDS = 300;
constexpr int32_t DRAG_THRESHOLD_PX        = 4;

// Cursor enum mirrored on the JS side and mapped to CSS strings there.
enum Cursor : int32_t
{
    CURSOR_DEFAULT   = 0,
    CURSOR_POINTER   = 1,
    CURSOR_GRAB      = 2,
    CURSOR_GRABBING  = 3,
    CURSOR_CROSSHAIR = 4,
};

enum Zone : int32_t
{
    ZONE_RULER = 0,
    ZONE_LABEL = 1,
    ZONE_WAVE  = 2,
};

enum DragMode : int32_t
{
    DRAG_NONE  = 0,
    DRAG_RULER = 1,
    DRAG_MOVE  = 2,
    DRAG_RANGE = 3,
    DRAG_PAN   = 4,
};

// Modifier bit-flags forwarded from JS (matches DOM event order so future
// flags can mirror it). Only bit 0 (Shift) is read today.
enum Modifier : int32_t
{
    MOD_SHIFT = 1 << 0,
};

struct DragState
{
    int32_t mode                = DRAG_NONE;
    int32_t initialMouseX       = 0;
    int32_t initialFrame        = 0;
    int32_t initialTrackStart   = 0;
    int32_t regionId            = -1;
    int32_t hitId               = -1;
    int32_t anchorFrame         = 0;
    int32_t hasMoved            = 0;
    int32_t initialScrollOffset = 0;
};

struct GestureCtx
{
    TransportStateView& state;
    TrackRegions&       regions;
    DragState&          drag;
};

inline int32_t timelineLength(const TransportStateView& state, const TrackRegions& regions)
{
    const int64_t track = regions.trackLength();
    const int64_t floor = static_cast<int64_t>(TIMELINE_DEFAULT_SECONDS) * state.sampleRate;
    return static_cast<int32_t>(std::max(track, floor));
}

inline int32_t visibleFrames(const TransportStateView& state, int32_t timeline)
{
    // NaN guard via `!(x >= 1.0f)` — std::clamp would propagate NaN.
    float zoom = state.displayZoom;
    if (!(zoom >= 1.0f)) { zoom = 1.0f; }
    if (zoom > 64.0f)    { zoom = 64.0f; }
    return std::max(1, static_cast<int32_t>(timeline / zoom));
}

inline int32_t pxToFrame(const TransportStateView& state,
                         const TrackRegions& regions,
                         int32_t xCss, const int32_t cssW)
{
    if (cssW <= 0) { return 0; }
    const int32_t tl = timelineLength(state, regions);
    if (tl <= 0) { return 0; }
    const int32_t vis = visibleFrames(state, tl);
    const int32_t off = state.scrollOffsetFrames.load(std::memory_order_acquire);
    xCss = std::clamp(xCss, 0, cssW);
    return off + static_cast<int32_t>(static_cast<double>(xCss) / cssW * vis);
}

inline int32_t zoneForY(const int32_t yCss)
{
    if (yCss < RULER_H_CSS)               { return ZONE_RULER; }
    if (yCss < RULER_H_CSS + LABEL_H_CSS) { return ZONE_LABEL; }
    return ZONE_WAVE;
}

inline int32_t hoverCursor(GestureCtx& ctx, const int32_t xCss, const int32_t yCss, const int32_t cssW)
{
    const int32_t zone = zoneForY(yCss);
    if (zone == ZONE_RULER) { return CURSOR_POINTER; }
    const int32_t frame = pxToFrame(ctx.state, ctx.regions, xCss, cssW);
    const int32_t hit   = ctx.regions.findCovering(frame);
    if (zone == ZONE_LABEL && hit >= 0) { return CURSOR_GRAB; }
    return CURSOR_CROSSHAIR;
}

inline int32_t handleMouseDown(GestureCtx& ctx, const int32_t xCss, const int32_t yCss,
                               const int32_t cssW, const int32_t modifiers)
{
    if (ctx.state.state.load(std::memory_order_acquire) == Transport::STATE_RECORDING)
    {
        return CURSOR_DEFAULT;
    }
    const int32_t tl = timelineLength(ctx.state, ctx.regions);
    if (tl <= 0) { return CURSOR_DEFAULT; }

    const int32_t zone  = zoneForY(yCss);
    const int32_t frame = pxToFrame(ctx.state, ctx.regions, xCss, cssW);

    if (zone == ZONE_RULER)
    {
        ctx.drag.mode          = DRAG_RULER;
        ctx.drag.initialMouseX = xCss;
        ctx.drag.initialFrame  = frame;
        ctx.drag.hasMoved      = 0;
        ctx.state.pos.store(frame, std::memory_order_seq_cst);
        return CURSOR_POINTER;
    }

    const int32_t hit = ctx.regions.findCovering(frame);

    if (zone == ZONE_LABEL && hit >= 0)
    {
        const Region& r = ctx.regions.get(hit);
        ctx.drag.mode              = DRAG_MOVE;
        ctx.drag.initialMouseX     = xCss;
        ctx.drag.initialFrame      = frame;
        ctx.drag.initialTrackStart = r.trackStartFrame.load(std::memory_order_acquire);
        ctx.drag.regionId          = hit;
        ctx.drag.hasMoved          = 0;
        return CURSOR_GRABBING;
    }

    // Shift+drag on empty wave area pans the timeline view; plain drag is
    // range selection (existing behavior).
    if ((modifiers & MOD_SHIFT) && hit < 0)
    {
        ctx.drag.mode                = DRAG_PAN;
        ctx.drag.initialMouseX       = xCss;
        ctx.drag.initialScrollOffset = ctx.state.scrollOffsetFrames.load(std::memory_order_acquire);
        ctx.drag.hasMoved            = 0;
        return CURSOR_GRABBING;
    }

    ctx.drag.mode          = DRAG_RANGE;
    ctx.drag.initialMouseX = xCss;
    ctx.drag.anchorFrame   = frame;
    ctx.drag.hitId         = hit;
    ctx.drag.hasMoved      = 0;
    return CURSOR_CROSSHAIR;
}

inline int32_t handleMouseMove(GestureCtx& ctx, const int32_t xCss, const int32_t yCss, const int32_t cssW)
{
    if (ctx.drag.mode == DRAG_NONE) { return hoverCursor(ctx, xCss, yCss, cssW); }

    const int32_t frame = pxToFrame(ctx.state, ctx.regions, xCss, cssW);
    if (std::abs(xCss - ctx.drag.initialMouseX) >= DRAG_THRESHOLD_PX)
    {
        ctx.drag.hasMoved = 1;
    }

    switch (ctx.drag.mode)
    {
        case DRAG_RULER:
            ctx.state.pos.store(frame, std::memory_order_seq_cst);
            return CURSOR_POINTER;

        case DRAG_MOVE:
            if (ctx.drag.hasMoved)
            {
                const int32_t tl       = timelineLength(ctx.state, ctx.regions);
                const int32_t vis      = visibleFrames(ctx.state, tl);
                const int32_t signedDx = xCss - ctx.drag.initialMouseX;
                const int32_t dxFrames = static_cast<int32_t>(
                    static_cast<double>(signedDx) / cssW * vis);
                const int32_t newStart = std::max(0, ctx.drag.initialTrackStart + dxFrames);
                Region& r = ctx.regions.get(ctx.drag.regionId);
                r.trackStartFrame.store(newStart, std::memory_order_release);
            }
            return CURSOR_GRABBING;

        case DRAG_RANGE:
            if (ctx.drag.hasMoved)
            {
                int32_t s = ctx.drag.anchorFrame;
                int32_t e = frame;
                if (s > e) { std::swap(s, e); }
                // End-first publish (see Transport::setRange).
                if (s == e)
                {
                    ctx.state.rangeStart.store(-1, std::memory_order_relaxed);
                    ctx.state.rangeEnd  .store(-1, std::memory_order_seq_cst);
                }
                else
                {
                    ctx.state.rangeStart.store(s, std::memory_order_relaxed);
                    ctx.state.rangeEnd  .store(e, std::memory_order_seq_cst);
                }
            }
            return CURSOR_CROSSHAIR;

        case DRAG_PAN:
            if (ctx.drag.hasMoved)
            {
                const int32_t tl       = timelineLength(ctx.state, ctx.regions);
                const int32_t vis      = visibleFrames(ctx.state, tl);
                const int32_t signedDx = xCss - ctx.drag.initialMouseX;
                // Grab-and-move: dragging right pulls earlier frames into view,
                // so the left edge (scrollOffset) decreases by dxFrames.
                const int32_t dxFrames = static_cast<int32_t>(
                    static_cast<double>(signedDx) / cssW * vis);
                const int32_t maxOff   = std::max(0, tl - vis);
                const int32_t newOff   = std::clamp(
                    ctx.drag.initialScrollOffset - dxFrames, 0, maxOff);
                ctx.state.scrollOffsetFrames.store(newOff, std::memory_order_release);
            }
            return CURSOR_GRABBING;
    }
    return CURSOR_DEFAULT;
}

// Resolves a click (mouseup with no drag) on the label or wave zone:
//   * Update region selection appropriately.
//   * Move the playhead to the click frame.
//   * Clear any range (wave-zone clicks).
// Returns -1 always — clicks never start playback. If the transport is
// already PLAYING, audio simply continues from the new pos; if IDLE, the
// playhead moves visually and the user can hit Play to hear from there.
// The return type is kept so the JS bridge can be a no-op forwarder.
inline int32_t handleMouseUp(GestureCtx& ctx, int32_t /*xCss*/, int32_t /*yCss*/, int32_t /*cssW*/)
{
    const int32_t mode     = ctx.drag.mode;
    const int32_t hasMoved = ctx.drag.hasMoved;

    if (mode == DRAG_MOVE && !hasMoved)
    {
        ctx.state.selectedRegionId.store(ctx.drag.regionId, std::memory_order_release);
        ctx.state.pos.store(ctx.drag.initialFrame, std::memory_order_seq_cst);
    }
    else if (mode == DRAG_RANGE && !hasMoved)
    {
        // End-first publish for the range pair (see Transport::setRange).
        // selectedRegionId / pos are independent and follow after.
        ctx.state.rangeStart.store(-1, std::memory_order_relaxed);
        ctx.state.rangeEnd  .store(-1, std::memory_order_seq_cst);
        ctx.state.selectedRegionId.store(ctx.drag.hitId, std::memory_order_release);
        ctx.state.pos.store(ctx.drag.anchorFrame, std::memory_order_seq_cst);
    }

    ctx.drag.mode = DRAG_NONE;
    return -1;
}

}  // namespace gestures
