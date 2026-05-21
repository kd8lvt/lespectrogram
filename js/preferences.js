// Persists user preferences in localStorage.
const Prefs = (() => {
    const KEY = "lespectrogram.prefs.v1";

    const DEFAULTS = {
        scaleType: "MEL",
        colorType: "JET",
        fftSize: 4096,
        smoothing: 0.8,
        autoFit: true,
        timeFlip: false, // Whether or not to flip the time axis labels, so 0s is on the left
        direction: "right", // Data entering from right (scrolls left) or left (scrolls right)
        showTooltip: true,  // Show Hz and exact Note on hover
        showHoverLine: true, // Show horizontal hover tracking line
        showNoteGrid: false, // Show faint horizontal lines at musical notes
        noteGridColor: "#ffffff",
        noteGridOpacity: 0.1,
        noteGridCOpacity: 0.4,
        minFrequency: 20,
        maxFrequency: 20000,
        minDecibels: -100,
        maxDecibels: -30,
        playbackSpeed: 1.0,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        enableSync: false,
        monitorInput: false,
        waveformGain: 1.0,
        renderMode: "frame", // "frame" or "delta"
        customColor1: "#000000",
        customColor2: "#330055",
        customColor3: "#bb0055",
        customColor4: "#ffffee"
    };

    let state = { ...DEFAULTS };
    const listeners = new Set();

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
        } catch (e) { /* ignore */ }
        return state;
    }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(state)); }
        catch (e) { /* ignore quota / privacy errors */ }
    }

    function get(key) { return state[key]; }
    function getAll() { return { ...state }; }

    function set(key, value) {
        if (state[key] === value) return;
        state[key] = value;
        save();
        listeners.forEach(fn => { try { fn(key, value); } catch (e) {} });
    }

    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    function reset() {
        state = { ...DEFAULTS };
        save();
        listeners.forEach(fn => fn(null, null));
    }

    return { load, save, get, set, getAll, onChange, reset, DEFAULTS };
})();

