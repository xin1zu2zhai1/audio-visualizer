const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let audioCtx, analyser, source, audioEl;
let freqData, timeData;
let mode = "bars";
let bgImg = null;

// スペクトログラム用（横に流す）
let spectrogramX = 0;

const W = canvas.width;
const H = canvas.height;

// ===== UI =====
document.getElementById("mode").onchange = e => mode = e.target.value;

document.getElementById("bgFile").onchange = e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => bgImg = img;
  img.src = URL.createObjectURL(file);
};

document.getElementById("audioFile").onchange = e => loadAudio(e.target.files?.[0]);
document.getElementById("play").onclick = () => audioEl?.play();
document.getElementById("stop").onclick = stopAll;

// ===== Audio setup =====
async function loadAudio(file) {
  stopAll();

  audioEl = new Audio(URL.createObjectURL(file));
  audioEl.crossOrigin = "anonymous";

  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();

  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.7;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -10;

  source = audioCtx.createMediaElementSource(audioEl);
  source.connect(analyser);
  analyser.connect(audioCtx.destination);

  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);

  spectrogramX = 0;
  ctx.clearRect(0, 0, W, H);

  requestAnimationFrame(draw);
}

function stopAll() {
  if (audioEl) audioEl.pause();
  audioEl = null;
}

// ===== Drawing =====
function drawBackground() {
  if (!bgImg) {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const scale = Math.max(W / bgImg.width, H / bgImg.height);
  const w = bgImg.width * scale;
  const h = bgImg.height * scale;
  ctx.drawImage(bgImg, (W - w) / 2, (H - h) / 2, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, W, H);
}

function draw() {
  if (!analyser) return;

  drawBackground();

  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);

  if (mode === "bars") drawBars();
  else if (mode === "wave") drawWave();
  else if (mode === "radial") drawRadial();
  else if (mode === "spectrogram") drawSpectrogram();

  requestAnimationFrame(draw);
}

// ===== Renderers =====
function drawBars() {
  const bands = 96;
  const nyquist = audioCtx.sampleRate / 2;

  for (let b = 0; b < bands; b++) {
    const f0 = 20 * Math.pow(20000 / 20, b / bands);
    const f1 = 20 * Math.pow(20000 / 20, (b + 1) / bands);
    const i0 = Math.floor(f0 / nyquist * freqData.length);
    const i1 = Math.max(i0 + 1, Math.floor(f1 / nyquist * freqData.length));

    let sum = 0;
    for (let i = i0; i < i1; i++) sum += freqData[i];
    const v = sum / (i1 - i0) / 255;

    const x = (b / bands) * W;
    const h = v * H * 0.8;
    ctx.fillStyle = "white";
    ctx.fillRect(x, H - h, W / bands * 0.9, h);
  }
}

function drawWave() {
  ctx.strokeStyle = "white";
  ctx.lineWidth = 2;
  ctx.beginPath();
  timeData.forEach((v, i) => {
    const x = i / (timeData.length - 1) * W;
    const y = H / 2 + ((v - 128) / 128) * H * 0.4;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawRadial() {
  const cx = W / 2, cy = H / 2;
  const base = Math.min(W, H) * 0.2;
  const bins = 128;

  for (let i = 0; i < bins; i++) {
    const angle = i / bins * Math.PI * 2;
    const v = freqData[i] / 255;
    const r = base + v * base;

    ctx.strokeStyle = "white";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * base, cy + Math.sin(angle) * base);
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    ctx.stroke();
  }
}

// ===== Spectrogram =====
function drawSpectrogram() {
  const bins = freqData.length;
  const imgData = ctx.getImageData(spectrogramX, 0, 1, H);
  for (let y = 0; y < H; y++) {
    const idx = Math.floor((1 - y / H) * bins);
    const v = freqData[idx] || 0;

    // dBっぽく見える疑似カラーマップ
    const r = v;
    const g = Math.max(0, v - 80);
    const b = 255 - v;

    const p = y * 4;
    imgData.data[p] = r;
    imgData.data[p + 1] = g;
    imgData.data[p + 2] = b;
    imgData.data[p + 3] = 255;
  }
  ctx.putImageData(imgData, spectrogramX, 0);
  spectrogramX = (spectrogramX + 1) % W;
}
