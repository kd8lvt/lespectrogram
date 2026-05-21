// UI wiring for toolbar dropdowns, settings panel, and pref persistence.
function wireDropdown(attr, labelId, nameMap, setter) {
    const dataKey = attr.replace('data-', '');
    document.querySelectorAll(`[${attr}]`).forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            const val = el.dataset[dataKey];
            setter(val);
            const labelEl = document.getElementById(labelId);
            if (labelEl) labelEl.textContent = nameMap[val] || val;
        });
    });
}

function setDropdownLabel(labelId, nameMap, value) {
    const el = document.getElementById(labelId);
    if (el) el.textContent = nameMap[value] || value;
}

const FFT_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768];

function buildFftSizeMenu() {
    const menu = document.getElementById("fftSizeMenu");
    if (!menu) return;
    menu.innerHTML = "";
    for (const sz of FFT_SIZES) {
        const li = document.createElement("li");
        li.innerHTML = `<a class="dropdown-item" href="#" data-fftsize="${sz}">${sz} bins (${sz / 2} freq)</a>`;
        menu.appendChild(li);
    }
}

function wireSettingsPanel(onChange) {
    // FFT size
    buildFftSizeMenu();
    document.querySelectorAll("[data-fftsize]").forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            const v = parseInt(el.dataset.fftsize, 10);
            Prefs.set("fftSize", v);
            document.getElementById("fftSizeLabel").textContent = `${v}`;
            onChange("fftSize", v);
        });
    });

    // Smoothing slider
    const smooth = document.getElementById("smoothingRange");
    const smoothVal = document.getElementById("smoothingVal");
    if (smooth) {
        smooth.addEventListener('input', () => {
            const v = parseFloat(smooth.value);
            smoothVal.textContent = v.toFixed(2);
            Prefs.set("smoothing", v);
            onChange("smoothing", v);
        });
    }

    // Min/Max Frequency
    const minFreqBtn = document.getElementById("opt_minFreq");
    const maxFreqBtn = document.getElementById("opt_maxFreq");
    if (minFreqBtn) {
        minFreqBtn.addEventListener('change', () => {
            const val = parseFloat(minFreqBtn.value) || 20;
            Prefs.set("minFrequency", val);
            onChange("minFrequency", val);
        });
    }
    if (maxFreqBtn) {
        maxFreqBtn.addEventListener('change', () => {
            const val = parseFloat(maxFreqBtn.value) || 20000;
            Prefs.set("maxFrequency", val);
            onChange("maxFrequency", val);
        });
    }

    const minDbBtn = document.getElementById("opt_minDb");
    const maxDbBtn = document.getElementById("opt_maxDb");
    if (minDbBtn) {
        minDbBtn.addEventListener('change', () => {
            const val = parseFloat(minDbBtn.value) || -100;
            Prefs.set("minDecibels", val);
            onChange("minDecibels", val);
        });
    }
    if (maxDbBtn) {
        maxDbBtn.addEventListener('change', () => {
            const val = parseFloat(maxDbBtn.value) || -30;
            Prefs.set("maxDecibels", val);
            onChange("maxDecibels", val);
        });
    }

    const playbackSpeedSel = document.getElementById("opt_playbackSpeed");
    if (playbackSpeedSel) {
        playbackSpeedSel.addEventListener('change', () => {
            const val = parseFloat(playbackSpeedSel.value) || 1.0;
            Prefs.set("playbackSpeed", val);
            onChange("playbackSpeed", val);
        });
    }

    [1, 2, 3, 4].forEach(i => {
        const cEl = document.getElementById(`opt_customColor${i}`);
        if (cEl) {
            cEl.addEventListener('change', () => {
                Prefs.set(`customColor${i}`, cEl.value);
                onChange(`customColor${i}`, cEl.value);
            });
        }
    });

    // Audio constraint toggles
    const toggles = ["echoCancellation", "noiseSuppression", "autoGainControl"];
    toggles.forEach(name => {
        const el = document.getElementById(`opt_${name}`);
        if (!el) return;
        el.addEventListener('change', () => {
            Prefs.set(name, el.checked);
            onChange(name, el.checked);
        });
    });

    const resetFreqBtn = document.getElementById("resetFreqBtn");
    if (resetFreqBtn) {
        resetFreqBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            Prefs.set("minFrequency", 20);
            Prefs.set("maxFrequency", 20000);
            if (minFreqBtn) minFreqBtn.value = 20;
            if (maxFreqBtn) maxFreqBtn.value = 20000;
            onChange("minFrequency", 20);
        });
    }

    const resetDbBtn = document.getElementById("resetDbBtn");
    if (resetDbBtn) {
        resetDbBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            Prefs.set("minDecibels", -100);
            Prefs.set("maxDecibels", -30);
            if (minDbBtn) minDbBtn.value = -100;
            if (maxDbBtn) maxDbBtn.value = -30;
            onChange("minDecibels", -100);
        });
    }

    const noteGridColorEl = document.getElementById("opt_noteGridColor");
    if (noteGridColorEl) {
        noteGridColorEl.addEventListener("change", () => {
            Prefs.set("noteGridColor", noteGridColorEl.value);
            onChange("noteGridColor", noteGridColorEl.value);
        });
    }

    const noteGridOpacityEl = document.getElementById("opt_noteGridOpacity");
    if (noteGridOpacityEl) {
        noteGridOpacityEl.addEventListener("input", () => {
            const val = parseFloat(noteGridOpacityEl.value) || 0.1;
            Prefs.set("noteGridOpacity", val);
            onChange("noteGridOpacity", val);
        });
    }

    const noteGridCOpacityEl = document.getElementById("opt_noteGridCOpacity");
    if (noteGridCOpacityEl) {
        noteGridCOpacityEl.addEventListener("input", () => {
            const val = parseFloat(noteGridCOpacityEl.value) || 0.4;
            Prefs.set("noteGridCOpacity", val);
            onChange("noteGridCOpacity", val);
        });
    }

    // Auto-fit toggle
    const autoFitEl = document.getElementById("opt_autoFit");
    if (autoFitEl) {
        autoFitEl.addEventListener('change', () => {
            Prefs.set("autoFit", autoFitEl.checked);
            onChange("autoFit", autoFitEl.checked);
        });
    }

    const tooltipEl = document.getElementById("opt_showTooltip");
    if (tooltipEl) {
        tooltipEl.addEventListener('change', () => {
            Prefs.set("showTooltip", tooltipEl.checked);
            onChange("showTooltip", tooltipEl.checked);
        });
    }

    const hoverLineEl = document.getElementById("opt_showHoverLine");
    if (hoverLineEl) {
        hoverLineEl.addEventListener('change', () => {
            Prefs.set("showHoverLine", hoverLineEl.checked);
            onChange("showHoverLine", hoverLineEl.checked);
        });
    }

    const noteGridEl = document.getElementById("opt_showNoteGrid");
    if (noteGridEl) {
        noteGridEl.addEventListener('change', () => {
            Prefs.set("showNoteGrid", noteGridEl.checked);
            onChange("showNoteGrid", noteGridEl.checked);
        });
    }

    const timeFlipEl = document.getElementById("opt_timeFlip");
    if (timeFlipEl) {
        timeFlipEl.addEventListener('change', () => {
            Prefs.set("timeFlip", timeFlipEl.checked);
            onChange("timeFlip", timeFlipEl.checked);
        });
    }

    const syncEl = document.getElementById("opt_enableSync");
    if (syncEl) {
        syncEl.addEventListener('change', () => {
            Prefs.set("enableSync", syncEl.checked);
            onChange("enableSync", syncEl.checked);
        });
    }

    const monitorEl = document.getElementById("opt_monitorInput");
    if (monitorEl) {
        monitorEl.addEventListener('change', () => {
            Prefs.set("monitorInput", monitorEl.checked);
            onChange("monitorInput", monitorEl.checked);
        });
    }

    const waveformGainEl = document.getElementById("opt_waveformGain");
    const waveformGainVal = document.getElementById("waveformGainVal");
    if (waveformGainEl) {
        waveformGainEl.addEventListener('input', () => {
            const v = parseFloat(waveformGainEl.value) || 1.0;
            if (waveformGainVal) waveformGainVal.textContent = v.toFixed(2) + "×";
            Prefs.set("waveformGain", v);
            onChange("waveformGain", v);
        });
    }

    document.querySelectorAll('input[name="opt_direction"]').forEach(el => {
        el.addEventListener('change', () => {
            if (el.checked) {
                Prefs.set("direction", el.value);
                onChange("direction", el.value);
            }
        });
    });

    // Reset button
    const resetEl = document.getElementById("prefsResetBtn");
    if (resetEl) {
        resetEl.addEventListener('click', e => {
            e.preventDefault();
            Prefs.reset();
            applyPrefsToUI();
            onChange(null, null);
        });
    }
}

function applyPrefsToUI() {
    const p = Prefs.getAll();
    setDropdownLabel("scaleLabel", SCALE_NAMES, p.scaleType);
    setDropdownLabel("colorLabel", COLOR_NAMES, p.colorType);

    const fftLbl = document.getElementById("fftSizeLabel");
    if (fftLbl) fftLbl.textContent = `${p.fftSize}`;

    const smooth = document.getElementById("smoothingRange");
    const smoothVal = document.getElementById("smoothingVal");
    if (smooth) { smooth.value = p.smoothing; }
    if (smoothVal) { smoothVal.textContent = Number(p.smoothing).toFixed(2); }

    const minFreqEl = document.getElementById("opt_minFreq");
    if (minFreqEl) minFreqEl.value = p.minFrequency || 20;

    const maxFreqEl = document.getElementById("opt_maxFreq");
    if (maxFreqEl) maxFreqEl.value = p.maxFrequency || 20000;

    const minDbEl = document.getElementById("opt_minDb");
    if (minDbEl) minDbEl.value = p.minDecibels || -100;

    const maxDbEl = document.getElementById("opt_maxDb");
    if (maxDbEl) maxDbEl.value = p.maxDecibels || -30;

    [1, 2, 3, 4].forEach(i => {
        const cEl = document.getElementById(`opt_customColor${i}`);
        if (cEl) cEl.value = p[`customColor${i}`] || "#000000";
    });

    const playbackSpeedSel = document.getElementById("opt_playbackSpeed");
    if (playbackSpeedSel) playbackSpeedSel.value = p.playbackSpeed || 1.0;

    const noteGridColorEl = document.getElementById("opt_noteGridColor");
    if (noteGridColorEl) noteGridColorEl.value = p.noteGridColor || "#ffffff";

    const noteGridOpacityEl = document.getElementById("opt_noteGridOpacity");
    if (noteGridOpacityEl) noteGridOpacityEl.value = p.noteGridOpacity !== undefined ? p.noteGridOpacity : 0.1;

    const noteGridCOpacityEl = document.getElementById("opt_noteGridCOpacity");
    if (noteGridCOpacityEl) noteGridCOpacityEl.value = p.noteGridCOpacity !== undefined ? p.noteGridCOpacity : 0.4;

    ["echoCancellation", "noiseSuppression", "autoGainControl"].forEach(name => {
        const el = document.getElementById(`opt_${name}`);
        if (el) el.checked = !!p[name];
    });

    const autoFitEl = document.getElementById("opt_autoFit");
    if (autoFitEl) autoFitEl.checked = !!p.autoFit;

    const tooltipEl = document.getElementById("opt_showTooltip");
    if (tooltipEl) tooltipEl.checked = !!p.showTooltip;

    const hoverLineEl = document.getElementById("opt_showHoverLine");
    if (hoverLineEl) hoverLineEl.checked = !!p.showHoverLine;

    const noteGridEl = document.getElementById("opt_showNoteGrid");
    if (noteGridEl) noteGridEl.checked = !!p.showNoteGrid;

    const timeFlipEl = document.getElementById("opt_timeFlip");
    if (timeFlipEl) timeFlipEl.checked = !!p.timeFlip;

    const dirEl = document.querySelector(`input[name="opt_direction"][value="${p.direction}"]`);
    if (dirEl) dirEl.checked = true;

    const syncEl = document.getElementById("opt_enableSync");
    if (syncEl) syncEl.checked = !!p.enableSync;

    const monitorEl = document.getElementById("opt_monitorInput");
    if (monitorEl) monitorEl.checked = !!p.monitorInput;

    const waveformGainEl = document.getElementById("opt_waveformGain");
    if (waveformGainEl) waveformGainEl.value = p.waveformGain != null ? p.waveformGain : 1.0;
    const waveformGainVal = document.getElementById("waveformGainVal");
    if (waveformGainVal) waveformGainVal.textContent = Number(p.waveformGain != null ? p.waveformGain : 1.0).toFixed(2) + "×";

    const modeNames = { "frame": "Smooth (Frame-based)", "strict": "Strict (Catch-up)" };
    setDropdownLabel("renderModeLabel", modeNames, p.renderMode);
}

