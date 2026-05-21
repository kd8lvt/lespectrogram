$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$src      = Join-Path $repoRoot "cpp/Exports.cpp"
$outDir   = Join-Path $repoRoot "wasm"
$out      = Join-Path $outDir "transport.wasm"

if (-not (Get-Command emcc -ErrorAction SilentlyContinue)) {
    Write-Error "emcc not on PATH. Open a new shell after activating emsdk, or run emsdk_env.ps1."
    exit 1
}

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$exports = @(
    "transport_init",
    "transport_state_ptr",
    "transport_regions_ptr",
    "transport_labels_ptr",
    "transport_max_regions",
    "transport_max_label",
    "transport_audio_buffer_ptr",
    "transport_audio_buffer_capacity_frames",
    "transport_load",
    "transport_play",
    "transport_stop",
    "transport_record",
    "transport_set_pos",
    "transport_set_range",
    "transport_set_display_zoom",
    "transport_set_loop_enabled",
    "transport_get_loop_enabled",
    "transport_region_at_frame",
    "transport_track_length",
    "transport_timeline_length",
    "transport_region_deactivate",
    "transport_regions_clear",
    "transport_label_scratch_ptr",
    "transport_region_set_label_from_scratch",
    "transport_process",
    "transport_input_ptr",
    "transport_output_ptr",
    "transport_wave_interpolate_range",
    "transport_wave_output_ptr",
    "transport_wave_max_pixels",
    "transport_drawlist_cmds_ptr",
    "transport_drawlist_text_ptr",
    "transport_drawlist_count",
    "transport_drawlist_max_cmds",
    "transport_drawlist_text_capacity",
    "transport_drawlist_cmd_stride_i32",
    "transport_pixels_ptr",
    "transport_pixels_max_w",
    "transport_pixels_max_h",
    "transport_render_drawlist",
    "transport_mouse_down",
    "transport_mouse_move",
    "transport_mouse_up",
    "transport_hover_cursor",
    "transport_drag_mode"
)

$emccArgs = @(
    $src,
    "-O3",
    "-std=c++17",
    "-fno-exceptions",
    "-fno-rtti",
    "-matomics",
    "-mbulk-memory",
    "-msimd128",
    "-sIMPORTED_MEMORY=1",
    "-sSHARED_MEMORY=1",
    "-sINITIAL_MEMORY=134217728",
    "-sSTANDALONE_WASM=1",
    "--no-entry",
    "-o", $out
)
foreach ($e in $exports) { $emccArgs += "-Wl,--export=$e" }

Write-Host "emcc -> $out"
& emcc @emccArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed (emcc exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

$size = (Get-Item $out).Length
Write-Host ("Built {0} ({1:N0} bytes)" -f $out, $size)
