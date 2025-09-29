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

let baselineComputed = false;
let browBaseline = 0;
let baselineFrames = 0;
const BASELINE_TARGET_FRAMES = 30;

const smooth = (prev, current, alpha=0.2) => prev + alpha * (current - prev);
let earSmoothed = 0, marSmoothed = 0, browSmoothed = 0;

let prevEyeState = null;
let prevMouthState = null;
let prevBrowState = null;

/* ========================== 
   Índices FaceMesh 
========================== */
const L_EYE = { left: 33, right: 133, top: 159, bottom: 145 };
const R_EYE = { left: 263, right: 362, top: 386, bottom: 374 };
const MOUTH = { left: 78, right: 308, top: 13, bottom: 14 };
const L_BROW_POINTS = [65,66,70];
const R_BROW_POINTS = [295,296,300];
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
   API Flask local
========================== */
const API_URLS = {
  parpadeo: "http://127.0.0.1:5000/parpadeo",
  ceja: "http://127.0.0.1:5000/ceja",
  boca: "http://127.0.0.1:5000/boca",
  ultimo: "http://127.0.0.1:5000/registros/ultimo",
  ultimos5: {
    parpadeos: "http://127.0.0.1:5000/ultimos5/parpadeos",
    cejas: "http://127.0.0.1:5000/ultimos5/cejas",
    bocas: "http://127.0.0.1:5000/ultimos5/bocas"
  }
};

/* ========================== 
   Guardado en API Flask 
========================== */
async function saveParpadeo(estado){
  try{
    await fetch(API_URLS.parpadeo,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ estado })
    });
    console.log("✅ Parpadeo guardado:", estado);
  }catch(err){ console.error("❌ Error al guardar parpadeo:",err); }
}

async function saveBoca(estado){
  try{
    await fetch(API_URLS.boca,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ estado })
    });
    console.log("✅ Boca guardada:", estado);
  }catch(err){ console.error("❌ Error al guardar boca:",err); }
}

async function saveCeja(estado){
  try{
    await fetch(API_URLS.ceja,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ estado })
    });
    console.log("✅ Ceja guardada:", estado);
  }catch(err){ console.error("❌ Error al guardar ceja:",err); }
}

/* ========================== 
   Geometría 
========================== */
function dist(a, b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
function avgY(landmarks, points){ return points.map(i=>landmarks[i].y).reduce((a,b)=>a+b,0)/points.length; }
function eyeEAR(landmarks, L, R){
  const earForEye = (eye) => {
    const horiz = dist(landmarks[eye.left], landmarks[eye.right]);
    const vert  = dist(landmarks[eye.top], landmarks[eye.bottom]);
    return vert / horiz;
  };
  return (earForEye(L) + earForEye(R)) / 2;
}
function mouthMAR(landmarks){
  const horiz = dist(landmarks[MOUTH.left], landmarks[MOUTH.right]);
  const vert  = dist(landmarks[MOUTH.top], landmarks[MOUTH.bottom]);
  return vert / horiz;
}
function browDistance(landmarks){
  const leftBrowY  = avgY(landmarks, L_BROW_POINTS);
  const rightBrowY = avgY(landmarks, R_BROW_POINTS);
  const leftEyeY   = avgY(landmarks, L_EYE_TOP_POINTS);
  const rightEyeY  = avgY(landmarks, R_EYE_TOP_POINTS);
  const lEyeHoriz = dist(landmarks[L_EYE.left], landmarks[L_EYE.right]);
  const rEyeHoriz = dist(landmarks[R_EYE.left], landmarks[R_EYE.right]);
  if(!isFinite(lEyeHoriz)||lEyeHoriz===0||!isFinite(rEyeHoriz)||rEyeHoriz===0){ return 0; }
  const lDist = (leftEyeY - leftBrowY) / lEyeHoriz;
  const rDist = (rightEyeY - rightBrowY) / rEyeHoriz;
  return (lDist + rDist) / 2;
}

/* ========================== 
   Render con OpenCV.js 
========================== */
function drawOverlay(frame, landmarks){
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  if(!landmarks) return;
  ctx.lineWidth = 2;
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
  [MOUTH.left, MOUTH.right, MOUTH.top, MOUTH.bottom].forEach(idx=>{
    const p = landmarks[idx];
    ctx.beginPath();
    ctx.arc(p.x*canvas.width,p.y*canvas.height,2.5,0,Math.PI*2);
    ctx.fillStyle = "rgba(77,163,255,0.9)";
    ctx.fill();
  });
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
   Contadores y guardado 
========================== */
function updateCounters(ear, mar, browDist){
  earSmoothed  = earSmoothed ? smooth(earSmoothed, ear) : ear;
  marSmoothed  = marSmoothed ? smooth(marSmoothed, mar) : mar;
  browSmoothed = browSmoothed ? smooth(browSmoothed, browDist) : browDist;

  earValueEl.textContent = earSmoothed.toFixed(3);
  marValueEl.textContent = marSmoothed.toFixed(3);
  browValueEl.textContent = (baselineComputed ? (browSmoothed - browBaseline) : browSmoothed).toFixed(3);

  if(!baselineComputed){
    browBaseline = (browBaseline*baselineFrames + browSmoothed)/(baselineFrames+1);
    baselineFrames++;
    statusBadge.textContent = `Calibrando (${Math.round(100*baselineFrames/BASELINE_TARGET_FRAMES)}%)`;
    if(baselineFrames>=BASELINE_TARGET_FRAMES){ baselineComputed=true; statusBadge.textContent="Listo"; }
  }

  let estadoOjo   = (earSmoothed < EAR_CLOSE_THR) ? "cerrado" : "abierto";
  let estadoBoca  = (marSmoothed > MAR_OPEN_THR) ? "abierta" : "cerrada";
  const delta = browSmoothed - browBaseline;
  let estadoCeja = (delta > BROW_RAISE_DELTA) ? "levantada" : "neutra";

  if (estadoOjo !== prevEyeState){ saveParpadeo(estadoOjo); prevEyeState=estadoOjo; if(estadoOjo==="cerrado"){ blinkCount++; blinkCountEl.textContent=blinkCount; } }
  if (estadoBoca !== prevMouthState){ saveBoca(estadoBoca); prevMouthState=estadoBoca; if(estadoBoca==="abierta"){ mouthCount++; mouthCountEl.textContent=mouthCount; } }
  if (estadoCeja !== prevBrowState){ saveCeja(estadoCeja); prevBrowState=estadoCeja; if(estadoCeja==="levantada"){ browRaiseCount++; browCountEl.textContent=browRaiseCount; } }

  eyeStateEl.textContent   = estadoOjo.charAt(0).toUpperCase()+estadoOjo.slice(1);
  mouthStateEl.textContent = estadoBoca.charAt(0).toUpperCase()+estadoBoca.slice(1);
  browStateEl.textContent  = estadoCeja.charAt(0).toUpperCase()+estadoCeja.slice(1);
}

/* ========================== 
   MediaPipe FaceMesh 
========================== */
faceMesh = new FaceMesh({ locateFile:(file)=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
faceMesh.setOptions({ maxNumFaces:1, refineLandmarks:true, minDetectionConfidence:0.6, minTrackingConfidence:0.6 });
faceMesh.onResults(onResults);

/* ========================== 
   Cámara 
========================== */
function startCamera(){
  if(running) return;
  running=true;
  canvas.width=canvas.clientWidth;
  canvas.height=canvas.clientHeight;
  camera=new Camera(video,{ onFrame:async()=>{ await faceMesh.send({image:video}); }, width:1280, height:800 });
  camera.start();
  statusBadge.textContent="Solicitando cámara…";
}
function stopCamera(){ if(camera){ camera.stop(); camera=null; } running=false; statusBadge.textContent="Detenida"; }

/* ========================== 
   Loop resultados 
========================== */
function onResults(results){
  const frame = results.image;
  const landmarks = results.multiFaceLandmarks && results.multiFaceLandmarks[0];
  drawOverlay(frame, landmarks);
  if(!landmarks){ eyeStateEl.textContent="Sin rostro"; mouthStateEl.textContent="Sin rostro"; browStateEl.textContent=baselineComputed?"Neutras":"Calibrando…"; return; }
  const ear = eyeEAR(landmarks, L_EYE, R_EYE);
  const mar = mouthMAR(landmarks);
  const brow = browDistance(landmarks);
  updateCounters(ear, mar, brow);
}

/* ========================== 
   Controles 
========================== */
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
btnReset.addEventListener('click', ()=>{
  blinkCount=mouthCount=browRaiseCount=0;
  blinkCountEl.textContent='0'; mouthCountEl.textContent='0'; browCountEl.textContent='0';
  earSmoothed=marSmoothed=browSmoothed=0;
  baselineComputed=false; browBaseline=0; baselineFrames=0;
  prevEyeState=prevMouthState=prevBrowState=null;
  statusBadge.textContent="Calibrando (0%)";
});
window.addEventListener('load', ()=>{ statusBadge.textContent="Listo para iniciar"; });

/* ========================== 
   📌 Tabla de registros con imágenes
========================== */
const tablaRegistros = qid("tablaRegistros");
const btnLastStatus  = qid("btnLastStatus");
const btnLast5       = qid("btnLast5");

const ICONS = {
  Parpadeo: { abierto:"img/ojosabiertos.jpg", cerrado:"img/ojoscerrados.jpg" },
  Boca: { abierta:"img/bocaabierta.jpg", cerrada:"img/bocacerrada.jpg" },
  Ceja: { levantada:"img/cejaslevantadas.jpg", neutra:"img/cejasneutras.jpg" }
};

function renderTabla(data){
  if(!data || data.length===0){
    tablaRegistros.innerHTML=`<tr><td colspan="4" style="text-align:center; color:var(--muted)">Sin datos</td></tr>`;
    return;
  }
  tablaRegistros.innerHTML=data.map(r=>{
    if(r.estado){
      let icon="—";
      if(ICONS[r.tipo] && ICONS[r.tipo][r.estado.toLowerCase()]){
        icon=`<img src="${ICONS[r.tipo][r.estado.toLowerCase()]}" alt="${r.estado}" style="width:40px; height:40px; object-fit:contain;">`;
      }
      return `<tr><td>${r.tipo}</td><td>${r.estado}</td><td>${icon}</td><td>${r.fecha_hora}</td></tr>`;
    }else{
      return `<tr><td colspan="4" style="text-align:center; font-weight:bold; color:var(--accent)">${r.tipo}</td></tr>`;
    }
  }).join("");
}

btnLastStatus.addEventListener("click", async ()=>{
  try{ const r=await fetch(API_URLS.ultimo); const data=await r.json(); renderTabla(data); }
  catch(err){ console.error("❌ Error obteniendo último estado:",err); }
});

btnLast5.addEventListener("click", async ()=>{
  try{
    const [rParp,rCej,rBoc]=await Promise.all([
      fetch(API_URLS.ultimos5.parpadeos), fetch(API_URLS.ultimos5.cejas), fetch(API_URLS.ultimos5.bocas)
    ]);
    let parp=await rParp.json(), cej=await rCej.json(), boc=await rBoc.json();
    parp=parp.map(r=>({...r,tipo:"Parpadeo"}));
    cej=cej.map(r=>({...r,tipo:"Ceja"}));
    boc=boc.map(r=>({...r,tipo:"Boca"}));
    let data=[];
    if(parp.length>0){ data.push({tipo:"--- Últimos 5 Parpadeos ---"}); data=data.concat(parp); }
    if(cej.length>0){ data.push({tipo:"--- Últimos 5 Cejas ---"}); data=data.concat(cej); }
    if(boc.length>0){ data.push({tipo:"--- Últimos 5 Bocas ---"}); data=data.concat(boc); }
    renderTabla(data);
  }catch(err){ console.error("❌ Error obteniendo últimos 5:",err); }
});
