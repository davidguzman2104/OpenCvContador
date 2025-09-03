/* ========================== 
   Utilidades de UI 
========================== */
const qs = (s) => document.querySelector(s);
const qid = (id) => document.getElementById(id);

const statusBadge = qid('statusBadge');
const blinkCountEl = qid('blinkCount');
const mouthCountEl = qid('mouthCount');
const browCountEl  = qid('browCount');

const earValueEl = qid('earValue');
const marValueEl = qid('marValue');
const browValueEl = qid('browValue');

const eyeStateEl = qid('eyeState');
const mouthStateEl = qid('mouthState');
const browStateEl = qid('browState');

const btnStart = qid('btnStart');
const btnStop  = qid('btnStop');
const btnReset = qid('btnReset');

const video = qid('video');
const canvas = qid('canvas');
const ctx = canvas.getContext('2d');

/* ========================== 
   Estado de la detección 
========================== */
let camera = null;
let running = false;
let faceMesh = null;

let blinkCount = 0;
let mouthCount = 0;
let browRaiseCount = 0;

let eyeClosed = false;
let mouthOpen = false;
let browRaised = false;

let baselineComputed = false;
let browBaseline = 0;
let baselineFrames = 0;
const BASELINE_TARGET_FRAMES = 30;

// Suavizado simple
const smooth = (prev, current, alpha=0.2) => prev + alpha * (current - prev);
let earSmoothed = 0, marSmoothed = 0, browSmoothed = 0;

/* ========================== 
   Índices FaceMesh 
========================== */
const L_EYE = { left: 33, right: 133, top: 159, bottom: 145 };
const R_EYE = { left: 263, right: 362, top: 386, bottom: 374 };
const MOUTH = { left: 78, right: 308, top: 13, bottom: 14 };

// Cejas (puntos promediados)
const L_BROW_POINTS = [65,66,70];
const R_BROW_POINTS = [295,296,300];

// Ojos (parte superior párpado)
const L_EYE_TOP_POINTS = [159,160,161];
const R_EYE_TOP_POINTS = [386,387,388];

/* ========================== 
   Umbrales 
========================== */
const EAR_CLOSE_THR = 0.25;
const EAR_OPEN_THR  = 0.3;
const MAR_OPEN_THR  = 0.5;
const MAR_CLOSE_THR = 0.4;
const BROW_RAISE_DELTA = 0.015;

/* ========================== 
   API de registro de gestos 
========================== */
const API_URL = 'https://68b89987b71540504328ab08.mockapi.io/api/v1/gestos';

/**
 * Registra un gesto en la API MockAPI
 * @param {"parpadeo"|"boca"|"cejas"} tipo
 */
async function logGesture(tipo){
  const payload = {
    cejas:     tipo === 'cejas'     ? 1 : 0,
    boca:      tipo === 'boca'      ? 1 : 0,
    parpadeo:  tipo === 'parpadeo'  ? 1 : 0,
    fechas_hora: new Date().toISOString()
  };

  try{
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      console.warn('No se pudo registrar el gesto:', res.status, await res.text());
    }
  }catch(err){
    console.warn('Error de red al registrar el gesto:', err);
  }
}

/* ========================== 
   Geometría 
========================== */
function dist(a, b){
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function avgY(landmarks, points){
  return points.map(i=>landmarks[i].y).reduce((a,b)=>a+b,0) / points.length;
}

function eyeEAR(landmarks, L, R){
  const earForEye = (eye) => {
    const horiz = dist(landmarks[eye.left], landmarks[eye.right]);
    const vert  = dist(landmarks[eye.top], landmarks[eye.bottom]);
    return vert / horiz;
  }
  return (earForEye(L) + earForEye(R)) / 2;
}

function mouthMAR(landmarks){
  const horiz = dist(landmarks[MOUTH.left], landmarks[MOUTH.right]);
  const vert  = dist(landmarks[MOUTH.top], landmarks[MOUTH.bottom]);
  return vert / horiz;
}

function browDistance(landmarks){
  const leftBrowY = avgY(landmarks, L_BROW_POINTS);
  const rightBrowY = avgY(landmarks, R_BROW_POINTS);
  const leftEyeY = avgY(landmarks, L_EYE_TOP_POINTS);
  const rightEyeY = avgY(landmarks, R_EYE_TOP_POINTS);

  const lEyeHoriz = dist(landmarks[L_EYE.left], landmarks[L_EYE.right]);
  const rEyeHoriz = dist(landmarks[R_EYE.left], landmarks[R_EYE.right]);

  const lDist = (leftBrowY - leftEyeY) / lEyeHoriz;
  const rDist = (rightBrowY - rightEyeY) / rEyeHoriz;

  return (lDist + rDist) / 2;
}

/* ========================== 
   Render con OpenCV.js 
========================== */
function drawOverlay(frame, landmarks){
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  if(!landmarks) return;

  ctx.lineWidth = 2;

  // Ojos
  [[L_EYE.left,L_EYE.right,L_EYE.top,L_EYE.bottom],
   [R_EYE.left,R_EYE.right,R_EYE.top,R_EYE.bottom]].forEach(([a,b,c,d])=>{
    ctx.beginPath();
    [a,b,c,d].forEach(idx=>{
      const p = landmarks[idx];
      ctx.moveTo(p.x*canvas.width,p.y*canvas.height);
      ctx.arc(p.x*canvas.width,p.y*canvas.height,2.5,0,Math.PI*2);
    });
    ctx.strokeStyle = "rgba(124,246,199,0.8)";
    ctx.stroke();
  });

  // Boca
  [MOUTH.left, MOUTH.right, MOUTH.top, MOUTH.bottom].forEach(idx=>{
    const p = landmarks[idx];
    ctx.beginPath();
    ctx.arc(p.x*canvas.width,p.y*canvas.height,2.5,0,Math.PI*2);
    ctx.fillStyle = "rgba(77,163,255,0.9)";
    ctx.fill();
  });

  // Cejas (línea simple de referencia)
  [L_BROW_POINTS, R_BROW_POINTS].forEach(points=>{
    ctx.beginPath();
    points.forEach((idx,i)=>{
        const p = landmarks[idx];
        if(i===0) ctx.moveTo(p.x*canvas.width, p.y*canvas.height);
        else ctx.lineTo(p.x*canvas.width, p.y*canvas.height);
    });
    ctx.strokeStyle="rgba(255,107,107,0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

/* ========================== 
   Contadores 
========================== */
function updateCounters(ear, mar, browDist, landmarks){
  // Suavizado
  earSmoothed  = earSmoothed ? smooth(earSmoothed, ear) : ear;
  marSmoothed  = marSmoothed ? smooth(marSmoothed, mar) : mar;
  browSmoothed = browSmoothed ? smooth(browSmoothed, browDist) : browDist;

  // Mostrar valores
  earValueEl.textContent = earSmoothed.toFixed(3);
  marValueEl.textContent = marSmoothed.toFixed(3);
  browValueEl.textContent = (baselineComputed ? (browSmoothed - browBaseline) : browSmoothed).toFixed(3);

  // Calibración
  if(!baselineComputed){
    browBaseline = (browBaseline*baselineFrames + browSmoothed)/(baselineFrames+1);
    baselineFrames++;
    statusBadge.textContent = `Calibrando (${Math.round(100*baselineFrames/BASELINE_TARGET_FRAMES)}%)`;
    if(baselineFrames>=BASELINE_TARGET_FRAMES){
      baselineComputed=true;
      statusBadge.textContent="Listo";
    }
  }

  // Ojos
  if(!eyeClosed && earSmoothed<EAR_CLOSE_THR){
    eyeClosed=true; eyeStateEl.textContent="Cerrados";
  }
  if(eyeClosed && earSmoothed>EAR_OPEN_THR){
    eyeClosed=false; 
    blinkCount++; 
    blinkCountEl.textContent=blinkCount; 
    eyeStateEl.textContent="Abiertos";
    logGesture('parpadeo'); // <-- enviar a API
  }

  // Boca
  if(!mouthOpen && marSmoothed>MAR_OPEN_THR){
    mouthOpen=true; mouthStateEl.textContent="Abierta";
  }
  if(mouthOpen && marSmoothed<MAR_CLOSE_THR){
    mouthOpen=false; 
    mouthCount++; 
    mouthCountEl.textContent=mouthCount; 
    mouthStateEl.textContent="Cerrada";
    logGesture('boca'); // <-- enviar a API
  }

  // Cejas
  const delta = browSmoothed - browBaseline;

  if(!browRaised && delta > BROW_RAISE_DELTA){
      browRaised = true;
      browStateEl.textContent = "Levantadas";
  }
  if(browRaised && delta < BROW_RAISE_DELTA * 0.5){
      browRaised = false;
      browRaiseCount++;
      browCountEl.textContent = browRaiseCount;
      browStateEl.textContent = "Neutras";
      logGesture('cejas'); // <-- enviar a API
  }
}

/* ========================== 
   MediaPipe FaceMesh 
========================== */
faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

faceMesh.onResults(onResults);

/* ========================== 
   Cámara 
========================== */
function startCamera(){
  if(running) return;
  running=true;
  canvas.width=canvas.clientWidth;
  canvas.height=canvas.clientHeight;

  camera = new Camera(video,{
    onFrame: async ()=>{ await faceMesh.send({image:video}); },
    width:1280, height:800
  });
  camera.start();
  statusBadge.textContent="Solicitando cámara…";
}

function stopCamera(){
  if(camera){ camera.stop(); camera=null; }
  running=false;
  statusBadge.textContent="Detenida";
}

/* ========================== 
   Loop resultados 
========================== */
function onResults(results){
  const frame = results.image;
  const landmarks = results.multiFaceLandmarks && results.multiFaceLandmarks[0];
  drawOverlay(frame, landmarks);

  if(!landmarks){
    eyeStateEl.textContent="Sin rostro";
    mouthStateEl.textContent="Sin rostro";
    browStateEl.textContent = baselineComputed ? "Neutras":"Calibrando…";
    return;
  }

  const ear = eyeEAR(landmarks, L_EYE, R_EYE);
  const mar = mouthMAR(landmarks);
  const brow = browDistance(landmarks);

  updateCounters(ear, mar, brow, landmarks);
}

/* ========================== 
   Controles 
========================== */
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
btnReset.addEventListener('click', ()=>{
  blinkCount=mouthCount=browRaiseCount=0;
  blinkCountEl.textContent='0';
  mouthCountEl.textContent='0';
  browCountEl.textContent='0';
  eyeClosed=mouthOpen=browRaised=false;
  earSmoothed=marSmoothed=browSmoothed=0;
  baselineComputed=false; browBaseline=0; baselineFrames=0;
  statusBadge.textContent="Calibrando (0%)";
});

window.addEventListener('load', ()=>{ statusBadge.textContent="Listo para iniciar"; });
