// C ABI bridge for the JS side. Hosts the singleton singletons (transport
// state, audio buffer, regions, wave interpolator) and the few entry points
// the JS bootstrap actually needs. Most reads happen through memory-mapped
// pointers (transport_state_ptr / transport_regions_ptr / transport_labels_ptr)
// rather than per-field getters.

#include <algorithm>
#include <cstdint>

#include "AudioBuffer.hpp"
#include "Region.hpp"
#include "Transport.hpp"
#include "WaveInterpolator.hpp"
#include "DrawList.hpp"
#include "PixelBuffer.hpp"
#include "WaveformRenderer.hpp"
#include "Gestures.hpp"

namespace
{
    constexpr int32_t MAX_QUANTUM = 256;

    TransportStateView   g_state;
    AudioBuffer          g_buffer;
    TrackRegions         g_regions;
    Transport            g_transport(g_buffer, g_regions, g_state);
    WaveInterpolator     g_waveInterp;
    DrawList             g_drawList;
    PixelBuffer          g_pixels;
    WaveformRenderer     g_waveRenderer;
    gestures::DragState  g_drag;
    gestures::GestureCtx g_gestureCtx{ g_state, g_regions, g_drag };

    alignas(16) float scratchIn [MAX_QUANTUM * AudioBuffer::MAX_CHANNELS];
    alignas(16) float scratchOut[MAX_QUANTUM * AudioBuffer::MAX_CHANNELS];

    // Bidirectional scratch for region label transfer.
    char labelScratch[TrackRegions::MAX_LABEL];
} // namespace

// EXPORT marks a function as part of the JS-visible C ABI. The actual export
// to the WASM module is done by -Wl,--export=name flags in build.ps1; the
// attribute is belt-and-suspenders. Guarded so non-Emscripten IDE indexers
// (e.g. CLion's clangd) don't trip on the visibility attribute.
#ifdef __EMSCRIPTEN__
#define EXPORT __attribute__((visibility("default")))
#else
#define EXPORT
#endif

extern "C" {

EXPORT void transport_init(const int32_t sampleRate, int32_t channels)
{
    channels = std::clamp(channels, 1, AudioBuffer::MAX_CHANNELS);

    g_state.state            .store(0,  std::memory_order_relaxed);
    g_state.pos              .store(0,  std::memory_order_seq_cst);
    g_state.tapeWriteHead    .store(0,  std::memory_order_relaxed);
    g_state.currentRegionId  .store(-1, std::memory_order_relaxed);
    g_state.selectedRegionId .store(-1, std::memory_order_relaxed);
    g_state.loopEnabled      .store(0,  std::memory_order_relaxed);
    g_state.rangeStart       .store(-1, std::memory_order_relaxed);
    g_state.rangeEnd         .store(-1, std::memory_order_seq_cst);
    g_state.scrollOffsetFrames.store(0, std::memory_order_relaxed);
    g_state.channels    = channels;
    g_state.sampleRate  = sampleRate;
    g_state.displayGain = 1.0f;
    g_state.displayZoom = 64.0f;
}

// Memory-mapped views: JS reads / writes these directly via typed-array
// views into shared memory.
EXPORT TransportStateView* transport_state_ptr()   { return &g_state;             }
EXPORT Region*             transport_regions_ptr() { return g_regions.itemsPtr(); }
EXPORT char*               transport_labels_ptr()  { return g_regions.labelsPtr();}
EXPORT int32_t             transport_max_regions() { return TrackRegions::MAX_REGIONS; }
EXPORT int32_t             transport_max_label()   { return TrackRegions::MAX_LABEL;   }

// Buffer is interleaved float32. JS deposits already-interleaved samples at
// transport_audio_buffer_ptr() (one shot per file load — not on a hot path),
// then transport_load() commits metadata and creates region 0.
EXPORT float*  transport_audio_buffer_ptr()             { return g_buffer.data(); }
EXPORT int32_t transport_audio_buffer_capacity_frames() { return AudioBuffer::capacityFrames(); }

EXPORT void transport_load(const int32_t frames, const int32_t channels, const int32_t sampleRate)
{
    g_buffer.load(frames, channels, sampleRate);
    g_regions.clearAll();
    if (frames > 0)
    {
        g_regions.add(0, 0, frames, channels);
    }

    g_transport.stop();
    g_transport.setPos(0);
    g_transport.setRange(-1, -1);
    g_state.loopEnabled       .store(0,      std::memory_order_release);
    g_state.selectedRegionId  .store(-1,     std::memory_order_release);
    g_state.tapeWriteHead     .store(frames, std::memory_order_release);
    g_state.scrollOffsetFrames.store(0,      std::memory_order_release);
    g_state.displayZoom = 64.0f;
}

// State-machine actions do more than store a value (allocate region,
// transition state, etc.), so they remain function calls rather than direct
// memory writes.
EXPORT void    transport_play()                  { g_transport.play();           }
EXPORT void    transport_stop()                  { g_transport.stop();           }
EXPORT int32_t transport_record()                { return g_transport.record();  }
EXPORT void    transport_set_pos(const int32_t f){ g_transport.setPos(f);        }
EXPORT void    transport_set_range(const int32_t s, const int32_t e) { g_transport.setRange(s, e); }

EXPORT void    transport_set_loop_enabled(const int32_t on)
{
    g_state.loopEnabled.store(on ? 1 : 0, std::memory_order_release);
}
EXPORT int32_t transport_get_loop_enabled()
{
    return g_state.loopEnabled.load(std::memory_order_acquire);
}

// Clamps to [1, 64] and resets scroll to 0 when zoom is 1× (full-fit view).
// NaN guard via `!(z >= 1.0f)` — std::clamp would propagate NaN.
EXPORT void transport_set_display_zoom(float z)
{
    if (!(z >= 1.0f)) { z = 1.0f; }
    if (z > 64.0f)    { z = 64.0f; }
    g_state.displayZoom = z;
    if (z == 1.0f)
    {
        g_state.scrollOffsetFrames.store(0, std::memory_order_release);
    }
}

// Region hit-test (newer-wins).
EXPORT int32_t transport_region_at_frame(const int32_t frame)
{
    return g_regions.findCovering(frame);
}

// Track-length helper (computed across active regions). This is the audio
// extent (used for end-of-playback logic).
EXPORT int32_t transport_track_length() { return g_regions.trackLength(); }

// Display timeline length: like a DAW project's default length. The visible
// timeline extends to at least DEFAULT_MIN seconds even when no audio reaches
// that far, so the user has empty timeline space to navigate. Auto-grows past
// the default if recordings exceed it.
EXPORT int32_t transport_timeline_length()
{
    constexpr int32_t DEFAULT_MIN_SECONDS = 300; // 5 minutes
    const int32_t track = g_regions.trackLength();
    const int32_t floor = DEFAULT_MIN_SECONDS * g_state.sampleRate;
    return std::max(track, floor);
}

EXPORT void transport_region_deactivate(const int32_t id)
{
    g_regions.deactivate(id);
    if (g_state.selectedRegionId.load(std::memory_order_relaxed) == id)
    {
        g_state.selectedRegionId.store(-1, std::memory_order_release);
    }
}

EXPORT void transport_regions_clear()
{
    g_regions.clearAll();
    g_state.selectedRegionId.store(-1, std::memory_order_release);
    g_state.tapeWriteHead   .store(0,  std::memory_order_release);
}

// Labels: JS pre-fills labelScratch with UTF-8 bytes, then calls
// transport_region_set_label_from_scratch(id, len). Reads slice the labels
// array (transport_labels_ptr) directly.
EXPORT char* transport_label_scratch_ptr() { return labelScratch; }
EXPORT void  transport_region_set_label_from_scratch(const int32_t id, const int32_t len)
{
    g_regions.setLabel(id, labelScratch, len);
}

EXPORT void transport_process(const int32_t frames)
{
    if (frames <= 0 || frames > MAX_QUANTUM)
    {
        return;
    }
    g_transport.process(scratchIn, scratchOut, frames);
}

EXPORT float* transport_input_ptr()  { return scratchIn;  }
EXPORT float* transport_output_ptr() { return scratchOut; }

EXPORT void transport_wave_interpolate_range(const int32_t startFrame,
                                             const int32_t lengthFrames,
                                             const int32_t channels,
                                             const int32_t pixels)
{
    g_waveInterp.computeRange(g_buffer, startFrame, lengthFrames,
                              channels, pixels, g_state.displayGain);
}

EXPORT const float* transport_wave_output_ptr() { return g_waveInterp.output();    }
EXPORT int32_t      transport_wave_max_pixels() { return WaveInterpolator::MAX_PIXELS; }

// Text-only drawlist: region labels and ruler timestamps. Rects/strokes
// moved to the RGBA PixelBuffer below — text stays here so Canvas2D's
// antialiased fillText can do the rasterization without baking a glyph
// atlas. All visualization math (positions, colors, ruler ticks, time
// formatting, range overlay, playhead) lives in WaveformRenderer.
EXPORT int32_t* transport_drawlist_cmds_ptr()       { return g_drawList.cmds;          }
EXPORT char*    transport_drawlist_text_ptr()       { return g_drawList.text;          }
EXPORT int32_t  transport_drawlist_count()          { return g_drawList.count;         }
EXPORT int32_t  transport_drawlist_max_cmds()       { return DrawList::MAX_CMDS;       }
EXPORT int32_t  transport_drawlist_text_capacity()  { return DrawList::TEXT_BYTES;     }
EXPORT int32_t  transport_drawlist_cmd_stride_i32() { return DrawList::CMD_STRIDE_I32; }

// Software-rasterized RGBA8888 frame for everything that isn't text. JS
// wraps this as a Uint8ClampedArray and blits it via putImageData in one
// call per frame.
EXPORT uint8_t* transport_pixels_ptr()        { return g_pixels.data;          }
EXPORT int32_t  transport_pixels_max_w()      { return PixelBuffer::MAX_W;     }
EXPORT int32_t  transport_pixels_max_h()      { return PixelBuffer::MAX_H;     }

EXPORT void transport_render_drawlist(const int32_t Wphys, const int32_t Hphys, const float dpr)
{
    g_waveRenderer.render(g_drawList, g_pixels, g_state, g_regions, g_buffer,
                          g_waveInterp, Wphys, Hphys, dpr);
}

// Mouse gesture entry points. JS forwards events; C++ owns drag state.
// Return values are JS-side useful: cursor enum (mouse_down / mouse_move /
// hover_cursor) or play-from frame (mouse_up; always -1 today — clicks never
// auto-play, so the JS bridge is a no-op forwarder).
//
// Only transport_mouse_down takes a `modifiers` bitmask. Drag mode is
// committed at mousedown, so modifier changes during move/up are ignored
// by design — that's why move/up have no modifiers parameter.
EXPORT int32_t transport_mouse_down(const int32_t xCss, const int32_t yCss, const int32_t cssW,
                                    const int32_t modifiers)
{
    return gestures::handleMouseDown(g_gestureCtx, xCss, yCss, cssW, modifiers);
}
EXPORT int32_t transport_mouse_move(const int32_t xCss, const int32_t yCss, const int32_t cssW)
{
    return gestures::handleMouseMove(g_gestureCtx, xCss, yCss, cssW);
}
EXPORT int32_t transport_mouse_up(const int32_t xCss, const int32_t yCss, const int32_t cssW)
{
    return gestures::handleMouseUp(g_gestureCtx, xCss, yCss, cssW);
}
EXPORT int32_t transport_hover_cursor(const int32_t xCss, const int32_t yCss, const int32_t cssW)
{
    return gestures::hoverCursor(g_gestureCtx, xCss, yCss, cssW);
}
EXPORT int32_t transport_drag_mode() { return g_drag.mode; }

} // extern "C"
