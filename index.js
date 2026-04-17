let spectrogram = null;

async function init() {
    const audioCtx = new AudioContext();
    document.getElementById("start").style.visibility = "hidden";

    navigator.mediaDevices.getUserMedia({video:false,audio:true}).then(stream=>{
        const analyser = audioCtx.createAnalyser()
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(analyser)
        
        const frqBuf = new Uint8Array(analyser.frequencyBinCount);
        const wfNumPts = 50*analyser.frequencyBinCount/256;
        const wfBufAry = {buffer:frqBuf};

        const wf = new Waterfall(wfBufAry,wfNumPts*3,wfNumPts*8,"right",{onscreenParentId:"root"});

        function draw() {
            analyser.getByteFrequencyData(frqBuf,0);

            requestAnimationFrame(draw)
        }

        draw();
        wf.start()
    });
}

window.addEventListener('DOMContentLoaded',()=>{
    document.getElementById("start").addEventListener('click',init);
})
