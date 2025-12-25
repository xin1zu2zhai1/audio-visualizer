// app.js (ESM)
// Audio analysis: Web Audio API + AnalyserNode
// Drawing: Canvas (1280x720 internal)
// Recording: canvas.captureStream + audio track (MediaStreamDestination)
// MP4 output: prefer direct mp4, else record webm then transcode to mp4 via ffmpeg.wasm

import { createFFmpeg, fetchFile } from "https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js";

const CANVAS_W = 1280;
const CANVAS_H = 720;
const TARGET_FPS = 60;

const el = {
  statusText: document.getElementById("statusText"),
  audioFile: document.getElementById("audioFile"),
  bgFile: document.getElementById("bgFile"),
  audioHint: document.getElementById("audioHint"),
  bgHint: document.getElementById("bgHint"),
  graphType: document.getElementById("graphType"),
  graphColor: document.getElementById("graphColor"),
  blend: document.getElementById("blend"),
  blendVal: document.getElementById("blendVal"),
  fftSize: document.getElementById("fftSize"),
  smoothing: document.getElementById("smoothing"),
  smoothingVal: document.getElementById("smoothingVal"),
  minDb: document.getElementById("minDb"),
  maxDb: document.getElementById("maxDb"),
  btnInit: document.getElementById("btnInit"),
  btnPlay: document.getElementById("btnPlay"),
  btnRecord: document.getElementById("btnRecord"),
  btnStop: document.getElementById("btnStop"),
  btnDownload: document.getElementById("btnDownload"),
  recDot: document.getElementById("recDot"),
  recText: document.getElementById("recText"),
  recProg: document.getElementById("recProg"),
  recHint: document.getElementById("recHint"),
  dlHint: document.getElementById("dlHint"),
  debugText: document.getElementById("debugText"),
  canvas: document.getElementById("canvas"),
  audio: document.getElementById("audio"),
};

const ctx2d = el.canvas.getContext("2d", { alpha: false });

let audioCtx = null;
let analyser = null;
let sourceNode = null;
let mediaDest = null;

let bgImg = null;
let bgImgURL = null;

let rafId = null;
let isInitialized = false;
let isPlaying = false;
let isRecording = false;

let freqData = null;
let timeData = null;

let recorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordedMime = "";
let downloadURL = null;

let recStartTs = 0;
let recTimerId = null;

let ffmpeg = null;
let ffmpegReady = false;

function setStatus(msg) {
  el.statusText.textContent = msg;
}

function setDebug(obj) {
  el.debugText.textContent = JSON.stringify(obj, null, 2);
}

function setBtnActive(button, active) {
  button.classList.toggle("active", !!active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function ensureCanvasSize() {
  if (el.canvas.width !== CANVAS_W) el.canvas.width = CANVAS_W;
  if (el.canvas.height !== CANVAS_H) el.canvas.height = CANVAS_H;
}

function drawBackground() {
  if (bgImg) {
    // cover-fit
    const cw = CANVAS_W, ch = CANVAS_H;
    const iw = bgImg.naturalWidth || bgImg.width;
    const ih = bgImg.naturalHeight || bgImg.height;
    const s = Math.max(cw / iw, ch / ih);
    const dw = iw * s;
    const dh = ih * s;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx2d.drawImage(bgImg, dx, dy, dw, dh);
  } else {
    ctx2d.fillStyle = "#000000";
    ctx2d.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  // dark overlay to improve readability
  const alpha = parseFloat(el.blend.value);
  ctx2d.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx2d.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function drawHUD() {
  const t = audioCtx ? audioCtx.currentTime : 0;
  const txt = [
    `Graph: ${el.graphType.value}`,
    `FFT: ${analyser ? analyser.fftSize : "-"}`,
    `Smoothing: ${analyser ? analyser.smoothingTimeConstant.toFixed(2) : "-"}`,
    `Time: ${t.toFixed(2)}s`,
  ];

  ctx2d.save();
  ctx2d.font = "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx2d.fillStyle = "rgba(255,255,255,0.85)";
  ctx2d.textBaseline = "top";

  const pad = 10;
  const boxW = 380;
  const lineH = 18;
  const boxH = pad * 2 + lineH * txt.length;

  ctx2d.fillStyle = "rgba(0,0,0,0.35)";
  ctx2d.fillRect(12, 12, boxW, boxH);

  ctx2d.fillStyle = "rgba(255,255,255,0.9)";
  txt.forEach((s, i) => ctx2d.fillText(s, 12 + pad, 12 + pad + i * lineH));

  // Recording indicator on canvas itself (useful in exported video)
  if (isRecording) {
    ctx2d.fillStyle = "rgba(255,77,79,0.95)";
    ctx2d.beginPath();
    ctx2d.arc(CANVAS_W - 24, 22, 8, 0, Math.PI * 2);
    ctx2d.fill();

    ctx2d.fillStyle = "rgba(255,255,255,0.9)";
    ctx2d.fillText("REC", CANVAS_W - 80, 12);
  }

  ctx2d.restore();
}

function drawBars(color) {
  if (!analyser || !freqData) return;

  analyser.getByteFrequencyData(freqData);

  const n = freqData.length;
  const margin = 40;
  const w = CANVAS_W - margin * 2;
  const h = CANVAS_H - margin * 2;

  // fewer bars (analysis feel): aggregate bins
  const bars = 120;
  const binPerBar = Math.max(1, Math.floor(n / bars));
  const barW = w / bars;

  ctx2d.save();
  ctx2d.translate(margin, margin);

  ctx2d.strokeStyle = "rgba(255,255,255,0.18)";
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, h);
  ctx2d.lineTo(w, h);
  ctx2d.stroke();

  ctx2d.fillStyle = color;

  for (let i = 0; i < bars; i++) {
    let sum = 0;
    const start = i * binPerBar;
    for (let k = 0; k < binPerBar; k++) {
      const idx = start + k;
      if (idx < n) sum += freqData[idx];
    }
    const v = sum / binPerBar; // 0..255
    const bh = (v / 255) * h;

    const x = i * barW;
    const y = h - bh;

    const rw = Math.max(1, barW * 0.7);
    ctx2d.fillRect(x + (barW - rw) / 2, y, rw, bh);
  }

  // axis labels (analysis-ish)
  ctx2d.fillStyle = "rgba(255,255,255,0.55)";
  ctx2d.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx2d.fillText("0 Hz", 0, h + 10);
  ctx2d.fillText("Nyquist", w - 62, h + 10);

  ctx2d.restore();
}

function drawWave(color) {
  if (!analyser || !timeData) return;

  analyser.getByteTimeDomainData(timeData);

  const margin = 40;
  const w = CANVAS_W - margin * 2;
  const h = CANVAS_H - margin * 2;
  const mid = margin + h / 2;

  ctx2d.save();

  // grid
  ctx2d.strokeStyle = "rgba(255,255,255,0.10)";
  ctx2d.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const y = margin + (h * i) / 8;
    ctx2d.beginPath();
    ctx2d.moveTo(margin, y);
    ctx2d.lineTo(margin + w, y);
    ctx2d.stroke();
  }

  // waveform
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();

  const n = timeData.length;
  for (let i = 0; i < n; i++) {
    const x = margin + (w * i) / (n - 1);
    const v = timeData[i] / 255; // 0..1
    const y = mid + (v - 0.5) * h * 0.85;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();

  // midline
  ctx2d.strokeStyle = "rgba(255,255,255,0.18)";
  ctx2d.beginPath();
  ctx2d.moveTo(margin, mid);
  ctx2d.lineTo(margin + w, mid);
  ctx2d.stroke();

  ctx2d.restore();
}

function drawCircle(color) {
  if (!analyser || !freqData) return;

  analyser.getByteFrequencyData(freqData);

  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;
  const baseR = Math.min(CANVAS_W, CANVAS_H) * 0.18;
  const maxR = Math.min(CANVAS_W, CANVAS_H) * 0.42;

  const bins = 200;
  const n = freqData.length;
  const step = Math.max(1, Math.floor(n / bins));

  ctx2d.save();

  // subtle rings
  ctx2d.strokeStyle = "rgba(255,255,255,0.10)";
  for (let r = baseR; r <= maxR; r += 30) {
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2d.stroke();
  }

  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 2;

  for (let i = 0; i < bins; i++) {
    let sum = 0;
    const start = i * step;
    for (let k = 0; k < step; k++) {
      const idx = start + k;
      if (idx < n) sum += freqData[idx];
    }
    const v = (sum / step) / 255; // 0..1
    const len = v * (maxR - baseR);

    const ang = (i / bins) * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + Math.cos(ang) * baseR;
    const y1 = cy + Math.sin(ang) * baseR;
    const x2 = cx + Math.cos(ang) * (baseR + len);
    const y2 = cy + Math.sin(ang) * (baseR + len);

    ctx2d.beginPath();
    ctx2d.moveTo(x1, y1);
    ctx2d.lineTo(x2, y2);
    ctx2d.stroke();
  }

  // center disk
  ctx2d.fillStyle = "rgba(0,0,0,0.35)";
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, baseR - 6, 0, Math.PI * 2);
  ctx2d.fill();

  ctx2d.restore();
}

function renderLoop() {
  ensureCanvasSize();
  drawBackground();

  const color = el.graphColor.value;

  if (analyser) {
    const gt = el.graphType.value;
    if (gt === "bars") drawBars(color);
    else if (gt === "wave") drawWave(color);
    else drawCircle(color);
  }

  drawHUD();

  rafId = requestAnimationFrame(renderLoop);
}

async function initAudioGraphIfNeeded() {
  if (isInitialized) return;

  if (!el.audio.src) {
    setStatus("音楽ファイルを選択してください");
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Create nodes
  analyser = audioCtx.createAnalyser();
  mediaDest = audioCtx.createMediaStreamDestination();

  // Apply analyser params
  analyser.fftSize = parseInt(el.fftSize.value, 10);
  analyser.smoothingTimeConstant = parseFloat(el.smoothing.value);
  analyser.minDecibels = parseFloat(el.minDb.value);
  analyser.maxDecibels = parseFloat(el.maxDb.value);

  // Connect audio element
  sourceNode = audioCtx.createMediaElementSource(el.audio);

  // routing: source -> analyser -> speakers
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  // routing for recording audio track: source -> mediaDest
  sourceNode.connect(mediaDest);

  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);

  isInitialized = true;
  setStatus("初期化完了（解析ON）");

  if (!rafId) renderLoop();

  setDebug({
    audioContextState: audioCtx.state,
    analyser: {
      fftSize: analyser.fftSize,
      frequencyBinCount: analyser.frequencyBinCount,
      smoothingTimeConstant: analyser.smoothingTimeConstant,
      minDecibels: analyser.minDecibels,
      maxDecibels: analyser.maxDecibels,
    },
    mediaRecorderSupport: typeof MediaRecorder !== "undefined",
  });
}

function updateAnalyzerParams() {
  if (!analyser) return;
  analyser.fftSize = parseInt(el.fftSize.value, 10);
  analyser.smoothingTimeConstant = parseFloat(el.smoothing.value);
  analyser.minDecibels = parseFloat(el.minDb.value);
  analyser.maxDecibels = parseFloat(el.maxDb.value);

  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);
}

function revokeDownloadURL() {
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = null;
}

function resetRecordingArtifacts() {
  recordedChunks = [];
  recordedBlob = null;
  recordedMime = "";
  revokeDownloadURL();
  el.btnDownload.disabled = true;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return `${mm}:${ss}`;
}

function startRecUI() {
  el.recDot.classList.add("on");
  el.recText.textContent = "録画：進行中（00:00）";
  el.recProg.style.width = "0%";
  el.recHint.textContent = "録画中…（グラフ切替OK）";

  recStartTs = performance.now();
  if (recTimerId) clearInterval(recTimerId);

  recTimerId = setInterval(() => {
    const ms = performance.now() - recStartTs;
    el.recText.textContent = `録画：進行中（${formatTime(ms)}）`;
    // a visible moving progress hint (not a duration-based bar)
    const pct = (ms / 1000) % 10 / 10 * 100; // cycles every 10s
    el.recProg.style.width = `${pct.toFixed(0)}%`;
  }, 150);
}

function stopRecUI() {
  el.recDot.classList.remove("on");
  el.recProg.style.width = "0%";
  if (recTimerId) clearInterval(recTimerId);
  recTimerId = null;
  el.recText.textContent = "録画：停止中";
  el.recHint.textContent = "※録画中もグラフ種類は切り替え可能";
}

function pickBestRecorderMime() {
  // Try MP4 first (often unsupported). Then WebM.
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function startRecording() {
  if (isRecording) return;
  await initAudioGraphIfNeeded();
  if (!isInitialized) return;

  if (audioCtx.state === "suspended") await audioCtx.resume();

  resetRecordingArtifacts();

  // Compose stream: video from canvas + audio from mediaDest
  const canvasStream = el.canvas.captureStream(TARGET_FPS);
  const audioTracks = mediaDest.stream.getAudioTracks();
  const composed = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioTracks,
  ]);

  const mime = pickBestRecorderMime();
  recordedMime = mime || "video/webm";

  try {
    recorder = new MediaRecorder(composed, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    setStatus("録画初期化に失敗（MediaRecorder設定）");
    setDebug({ error: String(e), triedMime: mime });
    return;
  }

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
  };

  recorder.onstart = () => {
    isRecording = true;
    setBtnActive(el.btnRecord, true);
    el.btnStop.disabled = false;
    startRecUI();
    setStatus(`録画中（${recordedMime}）`);
  };

  recorder.onerror = (ev) => {
    setStatus("録画エラー");
    setDebug({ recorderError: ev?.error ? String(ev.error) : "unknown" });
  };

  recorder.onstop = async () => {
    stopRecUI();
    setBtnActive(el.btnRecord, false);
    el.btnStop.disabled = true;

    const blob = new Blob(recordedChunks, { type: recordedMime });
    recordedBlob = blob;

    // If already MP4, enable download directly
    if (recordedMime.startsWith("video/mp4")) {
      downloadURL = URL.createObjectURL(blob);
      el.btnDownload.disabled = false;
      el.dlHint.textContent = "MP4を生成しました。";
      setStatus("録画完了（MP4）");
      return;
    }

    // Else transcode to MP4 using ffmpeg.wasm
    el.dlHint.textContent = "WebMをMP4に変換中…（重い処理なので少し待ちます）";
    setStatus("変換中（WebM→MP4）");

    try {
      const mp4Blob = await transcodeWebmToMp4(blob);
      recordedBlob = mp4Blob;
      downloadURL = URL.createObjectURL(mp4Blob);
      el.btnDownload.disabled = false;
      el.dlHint.textContent = "MP4を生成しました。";
      setStatus("録画完了（MP4へ変換）");
    } catch (e) {
      // Fallback: allow WebM download
      downloadURL = URL.createObjectURL(blob);
      el.btnDownload.disabled = false;
      el.dlHint.textContent = "MP4変換に失敗。代替としてWebMをダウンロードします。";
      setStatus("録画完了（WebM）");
      setDebug({ transcodeError: String(e) });
    }
  };

  // more frequent data for responsiveness
  recorder.start(200);
}

function stopAll() {
  if (isPlaying) {
    el.audio.pause();
  }
  if (isRecording && recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    stopRecUI();
  }
  isPlaying = false;
  setBtnActive(el.btnPlay, false);
  setBtnActive(el.btnRecord, false);
  el.btnStop.disabled = true;
}

async function ensureFFmpeg() {
  if (ffmpegReady) return;

  if (!ffmpeg) {
    ffmpeg = createFFmpeg({
      log: false,
      corePath: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js",
    });
  }

  el.dlHint.textContent = "ffmpeg.wasm 読み込み中…";
  await ffmpeg.load();
  ffmpegReady = true;
}

async function transcodeWebmToMp4(webmBlob) {
  await ensureFFmpeg();

  const inName = "input.webm";
  const outName = "output.mp4";

  // progress feedback (rough)
  el.recProg.style.width = "5%";
  el.recDot.classList.add("on");
  el.recText.textContent = "変換：進行中";

  ffmpeg.setProgress(({ ratio }) => {
    const pct = clamp(Math.round(ratio * 100), 0, 100);
    el.recProg.style.width = `${pct}%`;
    el.recText.textContent = `変換：進行中（${pct}%）`;
  });

  ffmpeg.FS("writeFile", inName, await fetchFile(webmBlob));

  // Reasonable defaults: H.264/AAC
  // If the build lacks some codecs, it can fail; that's why we catch errors.
  await ffmpeg.run(
    "-i", inName,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "192k",
    outName
  );

  const data = ffmpeg.FS("readFile", outName);

  // cleanup
  try { ffmpeg.FS("unlink", inName); } catch {}
  try { ffmpeg.FS("unlink", outName); } catch {}

  el.recProg.style.width = "0%";
  el.recDot.classList.remove("on");
  el.recText.textContent = "録画：停止中";

  return new Blob([data.buffer], { type: "video/mp4" });
}

// ---------- UI wiring ----------

el.blend.addEventListener("input", () => el.blendVal.textContent = Number(el.blend.value).toFixed(2));
el.smoothing.addEventListener("input", () => {
  el.smoothingVal.textContent = Number(el.smoothing.value).toFixed(2);
  updateAnalyzerParams();
});

el.fftSize.addEventListener("change", updateAnalyzerParams);
el.minDb.addEventListener("change", updateAnalyzerParams);
el.maxDb.addEventListener("change", updateAnalyzerParams);

el.audioFile.addEventListener("change", () => {
  const f = el.audioFile.files?.[0];
  if (!f) return;

  // reset everything because MediaElementSource cannot be re-created on same element in some edge cases
  stopAll();
  resetRecordingArtifacts();

  const url = URL.createObjectURL(f);
  el.audio.src = url;
  el.audio.load();

  el.audioHint.textContent = `${f.name} (${Math.round(f.size/1024/1024*10)/10} MB)`;
  setStatus("音楽ファイル読み込み済（未初期化）");

  // reset audio graph
  isInitialized = false;
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
  }
  audioCtx = null;
  analyser = null;
  sourceNode = null;
  mediaDest = null;

  if (!rafId) renderLoop();
});

el.bgFile.addEventListener("change", () => {
  const f = el.bgFile.files?.[0];
  if (!f) return;

  if (bgImgURL) URL.revokeObjectURL(bgImgURL);
  bgImgURL = URL.createObjectURL(f);

  bgImg = new Image();
  bgImg.onload = () => {
    el.bgHint.textContent = `${f.name} (${bgImg.naturalWidth}×${bgImg.naturalHeight})`;
    setStatus("背景画像を設定しました");
  };
  bgImg.src = bgImgURL;
});

el.btnInit.addEventListener("click", async () => {
  await initAudioGraphIfNeeded();
  // Enable play if audio loaded
  if (el.audio.src) {
    el.btnPlay.disabled = false;
  }
});

el.btnPlay.addEventListener("click", async () => {
  if (!el.audio.src) {
    setStatus("音楽ファイルを選択してください");
    return;
  }
  await initAudioGraphIfNeeded();
  if (!isInitialized) return;

  if (audioCtx.state === "suspended") await audioCtx.resume();

  if (!isPlaying) {
    try {
      await el.audio.play();
      isPlaying = true;
      setBtnActive(el.btnPlay, true);
      setStatus(isRecording ? "再生+録画中" : "再生中");
    } catch (e) {
      setStatus("再生に失敗（ユーザー操作が必要な場合があります）");
      setDebug({ playError: String(e) });
    }
  } else {
    el.audio.pause();
    isPlaying = false;
    setBtnActive(el.btnPlay, false);
    setStatus(isRecording ? "録画中（再生停止）" : "停止中");
  }
});

el.btnRecord.addEventListener("click", async () => {
  if (!el.audio.src) {
    setStatus("音楽ファイルを選択してください");
    return;
  }

  if (!isRecording) {
    await startRecording();
  } else {
    // stop recording only
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }
});

el.btnStop.addEventListener("click", () => {
  stopAll();
  setStatus("停止");
});

el.btnDownload.addEventListener("click", () => {
  if (!recordedBlob) return;
  if (!downloadURL) return;

  const isMp4 = recordedBlob.type === "video/mp4";
  const ext = isMp4 ? "mp4" : "webm";
  const a = document.createElement("a");
  a.href = downloadURL;
  a.download = `spectrum_recording_${new Date().toISOString().replace(/[:.]/g,"-")}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

el.audio.addEventListener("ended", () => {
  isPlaying = false;
  setBtnActive(el.btnPlay, false);
  setStatus(isRecording ? "録画中（再生終了）" : "再生終了");
});

// Init UI defaults
el.btnPlay.disabled = true;
el.blendVal.textContent = Number(el.blend.value).toFixed(2);
el.smoothingVal.textContent = Number(el.smoothing.value).toFixed(2);
setStatus("音楽ファイルを選択 → 初期化 → Play / Record");

// start render loop early for background/hud
renderLoop();
