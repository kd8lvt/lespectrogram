let spectrogram=null;
let paused=false;

async function init() {
    const audioCtx = new AudioContext();
    document.getElementById("start").style.display = "none";
    document.getElementById("pause").style.display = "";
    document.getElementById("reset").style.display = "";

    navigator.mediaDevices.getUserMedia({video:false,audio:true}).then(stream=>{
        const analyser = audioCtx.createAnalyser()
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(analyser)
        
        const frqBuf = new Uint8Array(analyser.frequencyBinCount);
        const wfNumPts = 50*analyser.frequencyBinCount/256;
        const wfBufAry = {buffer:frqBuf};

        spectrogram = new Waterfall(wfBufAry,wfNumPts*3,wfNumPts*8,"right",{onscreenParentId:"root"});

        function draw() {
            analyser.getByteFrequencyData(frqBuf,0);

            requestAnimationFrame(draw)
        }

        draw();
        spectrogram.start()
        spectrogram.clear()
    });
}

window.addEventListener('DOMContentLoaded',()=>{
    document.getElementById("start").addEventListener('click',init);
    document.getElementById("pause").addEventListener('click',()=>{
        paused=!paused
        if (paused) return spectrogram.stop();
        spectrogram.start()
    });
    document.getElementById("reset").addEventListener('click',()=>spectrogram.clear());
})
