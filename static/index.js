// G = global config that mirrors the sidebar sliders
const G = {
  floors: 10,
  capacity: 8,
  speed: 20,
  animId: null,
  data: null,       // raw JSON from the server after a run
};

// P = playback state for the frame-by-frame animation
const P = {
  frames: [],       // array of {a, b} frame pairs from both scenarios
  idx: 0,           // current frame index
  lastTs: null,     // last requestAnimationFrame timestamp
  accMs: 0,         // accumulated ms for frame advancement
  running: false,
  firstDraw: true,
};

// base interval between frames — actual speed is MS_PER_FRAME / G.speed
const MS_PER_FRAME = 80;

function el(id) { return document.getElementById(id); }

function onSlider(valId, val, suffix) {
  el(valId).textContent = val + suffix;
}

function setStatus(msg) { el("statusMsg").textContent = msg; }

function setControlsLocked(locked) {
  ["slFloors", "slCap", "slRate"].forEach((id) => {
    const e = el(id);
    if (e) e.disabled = locked;
  });
  const speed = el("slSpeed");
  if (speed) speed.disabled = false;
}

function setProgress(pct) {
  el("progFill").style.width = Math.min(pct, 100) + "%";
  el("progPct").textContent = pct > 0 ? Math.round(pct) + "%" : "";
}

function setClock(hours) {
  const h = Math.floor(hours);
  const m = Math.floor((hours % 1) * 60);
  el("simClock").textContent = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function fmtWait(seconds) {
  if (seconds <= 0) return "0 s";
  return seconds.toFixed(1) + " s";
}

function fmtQueue(val) {
  if (val <= 0) return "0";
  if (val < 10) return val.toFixed(1);
  return Math.round(val).toLocaleString();
}

function fmtPct(val) {
  return Number(val || 0).toFixed(2) + " %";
}

function setKpi(id, value) {
  const e = el(id);
  if (!e) return;
  e.classList.remove("empty");
  e.textContent = value;
}

function clearKpis() {
  ["kw-a", "kq-a", "ks-a", "kw-b", "kq-b", "ks-b"].forEach((id) => {
    const e = el(id);
    if (!e) return;
    e.classList.add("empty");
    e.textContent = "-";
  });
}

function ce(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function rebuildViz() {
  G.floors = +el("slFloors").value;
  G.capacity = +el("slCap").value;
  buildViz("buildA", 1);
  buildViz("buildB", 2);
}

function buildViz(wrapperId, numElevators) {
  const wrap = el(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = "";

  const floors = G.floors;

  const labels = ce("div", "floor-labels");
  for (let f = floors; f >= 1; f--) {
    const d = ce("div", "floor-label");
    d.textContent = f;
    labels.appendChild(d);
  }
  wrap.appendChild(labels);

  const shafts = ce("div", "shafts");
  const names = numElevators === 1 ? ["E-A"] : ["E-A", "E-B"];
  const classes = numElevators === 1 ? ["car-a"] : ["car-a", "car-b"];

  for (let s = 0; s < numElevators; s++) {
    const group = ce("div", "shaft-group");
    const lbl = ce("div", "shaft-label");
    lbl.textContent = names[s];
    group.appendChild(lbl);

    const shaft = ce("div", "shaft");
    shaft.id = `${wrapperId}-shaft-${s}`;

    const grid = ce("div", "shaft-grid");
    for (let i = 0; i < floors; i++) grid.appendChild(ce("div", "shaft-grid-line"));
    shaft.appendChild(grid);

    const car = ce("div", `elevator-car ${classes[s]}`);
    car.id = `${wrapperId}-car-${s}`;
    car.innerHTML =
      `<div class="car-dir" id="${wrapperId}-dir-${s}">-</div>` +
      `<div class="car-id">${names[s]}</div>` +
      `<div class="car-load" id="${wrapperId}-load-${s}">0/${G.capacity}</div>`;
    shaft.appendChild(car);

    group.appendChild(shaft);
    shafts.appendChild(group);
  }
  wrap.appendChild(shafts);

  const qcol = ce("div", "queue-col");
  const qhdr = ce("div", "queue-col-hdr");
  qhdr.textContent = "QUEUE";
  qcol.appendChild(qhdr);
  for (let f = floors; f >= 1; f--) {
    const row = ce("div", "queue-row");
    row.id = `${wrapperId}-q${f}`;
    qcol.appendChild(row);
  }
  wrap.appendChild(qcol);

  requestAnimationFrame(() => {
    for (let s = 0; s < numElevators; s++) moveCar(wrapperId, s, 1, false);
  });
}

function moveCar(vizId, shaftIdx, floor, animate) {
  const car = el(`${vizId}-car-${shaftIdx}`);
  const shaft = el(`${vizId}-shaft-${shaftIdx}`);
  if (!car || !shaft) return;

  const shaftH = shaft.clientHeight;
  const floorH = shaftH / G.floors;
  car.style.height = Math.max(floorH - 6, 18) + "px";

  const frameMs = MS_PER_FRAME / Math.max(G.speed, 1);
  const travelMs = Math.max(30, Math.min(180, frameMs * 0.85));
  car.style.transition = (animate && frameMs >= 35) ? `bottom ${travelMs}ms linear` : "none";
  car.style.bottom = ((floor - 1) * floorH + 3) + "px";
}

function setDirection(vizId, shaftIdx, dir) {
  const e = el(`${vizId}-dir-${shaftIdx}`);
  if (!e) return;
  e.textContent = dir === 1 ? "^" : dir === -1 ? "v" : "-";
  e.className = "car-dir" + (dir === 1 ? " dir-up" : dir === -1 ? " dir-down" : "");
}

function setLoad(vizId, shaftIdx, load) {
  const e = el(`${vizId}-load-${shaftIdx}`);
  if (!e) return;
  e.textContent = `${load}/${G.capacity}`;
}

function drawQueue(vizId, floor, count) {
  const e = el(`${vizId}-q${floor}`);
  if (!e) return;
  e.innerHTML = "";
  if (count === 0) return;

  if (count <= 20) {
    for (let i = 0; i < count; i++) e.appendChild(ce("div", "q-dot"));
    return;
  }

  const bar = ce("div", "q-bar");
  const ratio = Math.min(count / 100, 1);
  bar.style.width = Math.max(ratio * 80, 10) + "%";
  e.appendChild(bar);

  const lbl = ce("span", "q-count");
  lbl.textContent = count.toLocaleString();
  e.appendChild(lbl);
}

function drawFrame(framePair, animate) {
  const fa = framePair.a;
  const fb = framePair.b;

  moveCar("buildA", 0, fa.ef[0], animate);
  setLoad("buildA", 0, fa.el[0]);
  setDirection("buildA", 0, fa.ed ? fa.ed[0] : 0);
  for (let i = 1; i <= G.floors; i++) drawQueue("buildA", i, fa.ql[i - 1] || 0);

  moveCar("buildB", 0, fb.ef[0], animate);
  setLoad("buildB", 0, fb.el[0]);
  setDirection("buildB", 0, fb.ed ? fb.ed[0] : 0);
  if (fb.ef.length > 1) {
    moveCar("buildB", 1, fb.ef[1], animate);
    setLoad("buildB", 1, fb.el[1]);
    setDirection("buildB", 1, fb.ed ? fb.ed[1] : 0);
  }
  for (let i = 1; i <= G.floors; i++) drawQueue("buildB", i, fb.ql[i - 1] || 0);

  setKpi("kw-a", fmtWait(fa.aw));
  setKpi("kq-a", fmtQueue(fa.aq));
  setKpi("ku-a", fmtPct(fa.ut));
  setKpi("ks-a", (fa.ps ?? 0).toLocaleString());

  setKpi("kw-b", fmtWait(fb.aw));
  setKpi("kq-b", fmtQueue(fb.aq));
  setKpi("ku-b", fmtPct(fb.ut));
  setKpi("ks-b", (fb.ps ?? 0).toLocaleString());

  setClock(fa.t);
  setProgress((P.idx / (P.frames.length - 1)) * 100);
}

// Main animation loop — advances frames based on elapsed real time × speed multiplier
function animLoop(ts) {
  if (!P.running) return;

  if (P.lastTs === null) P.lastTs = ts;
  P.accMs += (ts - P.lastTs) * G.speed;
  P.lastTs = ts;

  while (P.accMs >= MS_PER_FRAME && P.idx < P.frames.length - 1) {
    P.accMs -= MS_PER_FRAME;
    P.idx++;
  }

  drawFrame(P.frames[P.idx], !P.firstDraw);
  P.firstDraw = false;

  if (P.idx >= P.frames.length - 1) {
    P.running = false;
    G.animId = null;
    setClock(G.data.params.duration_hr);
    setProgress(100);
    setStatus("Simulation complete");

    const ka = G.data.scenario_a.kpis;
    const kb = G.data.scenario_b.kpis;
    setKpi("kw-a", fmtWait(ka.avg_wait_served));
    setKpi("kq-a", fmtQueue(ka.avg_queue));
    setKpi("ku-a", fmtPct(ka.utilization));
    setKpi("ks-a", ka.passengers_served.toLocaleString());

    setKpi("kw-b", fmtWait(kb.avg_wait_served));
    setKpi("kq-b", fmtQueue(kb.avg_queue));
    setKpi("ku-b", fmtPct(kb.utilization));
    setKpi("ks-b", kb.passengers_served.toLocaleString());

    showResults();
    el("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  G.animId = requestAnimationFrame(animLoop);
}

function showResults() {
  const panel = el("resultsPanel");
  const a = G.data.scenario_a.kpis;
  const b = G.data.scenario_b.kpis;
  const p = G.data.params;

  const better = (aWins) => (aWins ? '<span class="badge-better">BETTER</span>' : "");
  const row = (label, avText, bvText, avNum, bvNum, lowerIsBetter) => {
    const aWins = lowerIsBetter ? avNum <= bvNum : avNum >= bvNum;
    return `<tr><td class="r-metric">${label}</td><td class="r-a">${avText} ${better(aWins)}</td><td class="r-b">${bvText} ${better(!aWins)}</td></tr>`;
  };

  panel.innerHTML = `
  <div class="rp-inner">
    <div class="rp-header">
      <div>
        <div class="rp-title">Simulation Results</div>
        <div class="rp-sub">${p.floors} floors - λ=${p.arrival} pax/min - ${p.duration_hr}h </div>
      </div>
      <div class="rp-actions">
        <button class="btn-csv" onclick="downloadCSV()">CSV</button>
        <button class="btn-tryagain" onclick="tryAgain()">Try Again</button>
      </div>
    </div>

    <table class="rtable">
      <thead><tr><th>Metric</th><th class="th-a">A - 1 Elevator</th><th class="th-b">B - 2 Elevators</th></tr></thead>
      <tbody>
        ${row("Avg Wait", fmtWait(a.avg_wait_served), fmtWait(b.avg_wait_served), a.avg_wait_served, b.avg_wait_served, true)}
        ${row("Avg Queue", fmtQueue(a.avg_queue) + " pax", fmtQueue(b.avg_queue) + " pax", a.avg_queue, b.avg_queue, true)}
        ${row("Utilization", fmtPct(a.utilization), fmtPct(b.utilization), a.utilization, b.utilization, false)}
        ${row("Passengers Served", a.passengers_served, b.passengers_served, a.passengers_served, b.passengers_served, false)}
      </tbody>
    </table>
  </div>`;

  panel.classList.add("show");
}

function hideResults() {
  const p = el("resultsPanel");
  p.classList.remove("show");
  p.innerHTML = "";
}

function tryAgain() {
  if (G.animId) {
    cancelAnimationFrame(G.animId);
    G.animId = null;
  }
  P.running = false;
  G.data = null;
  hideResults();
  clearKpis();
  setClock(0);
  setProgress(0);
  setStatus("Set parameters and press Run");
  buildViz("buildA", 1);
  buildViz("buildB", 2);
  el("btnRun").disabled = false;
  setControlsLocked(false);
}

// Sends params to the server, waits for simulation to finish, then starts playback
async function runSimulation() {
  if (G.animId) {
    cancelAnimationFrame(G.animId);
    G.animId = null;
  }

  G.floors = +el("slFloors").value;
  G.capacity = +el("slCap").value;
  G.speed = +el("slSpeed").value;
  const arrival = +el("slRate").value;

  buildViz("buildA", 1);
  buildViz("buildB", 2);
  clearKpis();
  hideResults();
  setClock(0);
  setProgress(0);
  setStatus("Computing simulation...");
  el("btnRun").disabled = true;
  setControlsLocked(true);
  el("loadingOverlay").style.display = "flex";

  let data;
  try {
    const res = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ floors: G.floors, capacity: G.capacity, arrival }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "Server error " + res.status);
    }
    data = await res.json();
  } catch (err) {
    el("loadingOverlay").style.display = "none";
    setStatus("X " + err.message);
    el("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  el("loadingOverlay").style.display = "none";
  G.data = data;

  const fa = data.scenario_a.frames;
  const fb = data.scenario_b.frames;
  const n = Math.min(fa.length, fb.length);
  P.frames = Array.from({ length: n }, (_, i) => ({ a: fa[i], b: fb[i] }));
  P.idx = 0;
  P.lastTs = null;
  P.accMs = 0;
  P.running = true;
  P.firstDraw = true;

  if (n === 0) {
    setStatus("No frames generated. Try a higher arrival rate.");
    el("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  setStatus("Animating...");
  requestAnimationFrame(animLoop);
}

// Builds a CSV from the final KPIs and triggers a browser download
function downloadCSV() {
  if (!G.data) return;
  const d = G.data;
  const a = d.scenario_a.kpis;
  const b = d.scenario_b.kpis;
  const p = d.params;

  const lines = [];
  lines.push("ELEVATOR SIMULATION RESULTS");
  lines.push(`Floors,${p.floors}`);
  lines.push(`Capacity,${p.capacity}`);
  lines.push(`Arrival Rate,${p.arrival}`);
  lines.push(`Duration (hr),${p.duration_hr}`);
  lines.push(`Replications,${p.reps}`);
  lines.push("");
  lines.push("Metric,Scenario A,Scenario B");
  lines.push(`Avg Wait Served (s),${a.avg_wait_served},${b.avg_wait_served}`);
  lines.push(`Avg Wait Backlog (s),${a.avg_wait_backlog},${b.avg_wait_backlog}`);
  lines.push(`Max Wait (s),${a.max_wait_served},${b.max_wait_served}`);
  lines.push(`Avg Queue,${a.avg_queue},${b.avg_queue}`);
  lines.push(`Utilization (%),${a.utilization},${b.utilization}`);
  lines.push(`Passengers Served,${a.passengers_served},${b.passengers_served}`);

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const aEl = Object.assign(document.createElement("a"), {
    href: url,
    download: `elevasim_${p.floors}fl_${p.arrival}pax.csv`,
  });
  aEl.click();
  URL.revokeObjectURL(url);
}

window.addEventListener("load", () => {
  buildViz("buildA", 1);
  buildViz("buildB", 2);
  setControlsLocked(false);
  el("btnRun").onclick = runSimulation;

  el("slFloors").oninput = function () { onSlider("valFloors", this.value, ""); rebuildViz(); };
  el("slCap").oninput = function () { onSlider("valCap", this.value, " pax"); rebuildViz(); };
  el("slRate").oninput = function () { onSlider("valRate", this.value, " /min"); };
  el("slSpeed").oninput = function () { onSlider("valSpeed", this.value, "x"); G.speed = +this.value; };
});
