// ElevaSim frontend controller

const G = {
  floors: 10,
  capacity: 8,
  speed: 20,
  animId: null,
  data: null,
};

const P = {
  frames: [],
  idx: 0,
  lastTs: null,
  accMs: 0,
  running: false,
  firstDraw: true,
};

const MS_PER_FRAME = 80;

function $(id) { return document.getElementById(id); }

function onSlider(valId, val, suffix) {
  $(valId).textContent = val + suffix;
}

function setStatus(msg) { $("statusMsg").textContent = msg; }

function setControlsLocked(locked) {
  ["slFloors", "slCap", "slRate"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = locked;
  });
  const speed = $("slSpeed");
  if (speed) speed.disabled = false;
}

function setProgress(pct) {
  $("progFill").style.width = Math.min(pct, 100) + "%";
  $("progPct").textContent = pct > 0 ? Math.round(pct) + "%" : "";
}

function setClock(hours) {
  const h = Math.floor(hours);
  const m = Math.floor((hours % 1) * 60);
  $("simClock").textContent = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function fmtWait(seconds) {
  if (seconds <= 0) return "0 s";
  if (seconds < 60) return seconds.toFixed(1) + " s";
  if (seconds < 3600) return (seconds / 60).toFixed(1) + " min";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h + "h " + m + "m";
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
  const el = $(id);
  if (!el) return;
  el.classList.remove("empty");
  el.textContent = value;
}

function clearKpis() {
  ["kw-a", "kq-a", "ku-a", "ks-a", "kw-b", "kq-b", "ku-b", "ks-b"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.classList.add("empty");
    el.textContent = "-";
  });
}

function ce(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function rebuildViz() {
  G.floors = +$("slFloors").value;
  G.capacity = +$("slCap").value;
  buildViz("buildA", 1);
  buildViz("buildB", 2);
}

function buildViz(wrapperId, numElevators) {
  const wrap = $(wrapperId);
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
  const car = $(`${vizId}-car-${shaftIdx}`);
  const shaft = $(`${vizId}-shaft-${shaftIdx}`);
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
  const el = $(`${vizId}-dir-${shaftIdx}`);
  if (!el) return;
  el.textContent = dir === 1 ? "^" : dir === -1 ? "v" : "-";
  el.className = "car-dir" + (dir === 1 ? " dir-up" : dir === -1 ? " dir-down" : "");
}

function setLoad(vizId, shaftIdx, load) {
  const el = $(`${vizId}-load-${shaftIdx}`);
  if (!el) return;
  el.textContent = `${load}/${G.capacity}`;
}

function drawQueue(vizId, floor, count) {
  const el = $(`${vizId}-q${floor}`);
  if (!el) return;
  el.innerHTML = "";
  if (count === 0) return;

  if (count <= 20) {
    for (let i = 0; i < count; i++) el.appendChild(ce("div", "q-dot"));
    return;
  }

  const bar = ce("div", "q-bar");
  const ratio = Math.min(count / 100, 1);
  bar.style.width = Math.max(ratio * 80, 10) + "%";
  el.appendChild(bar);

  const lbl = ce("span", "q-count");
  lbl.textContent = count.toLocaleString();
  el.appendChild(lbl);
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
    setClock(8);
    setProgress(100);
    setStatus("Simulation complete");

    const ka = G.data.scenario_a.kpis;
    const kb = G.data.scenario_b.kpis;
    setKpi("kw-a", fmtWait(ka.avg_wait));
    setKpi("kq-a", fmtQueue(ka.avg_queue));
    setKpi("ku-a", fmtPct(ka.utilization));
    setKpi("ks-a", ka.passengers_served.toLocaleString());

    setKpi("kw-b", fmtWait(kb.avg_wait));
    setKpi("kq-b", fmtQueue(kb.avg_queue));
    setKpi("ku-b", fmtPct(kb.utilization));
    setKpi("ks-b", kb.passengers_served.toLocaleString());

    showResults();
    $("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  G.animId = requestAnimationFrame(animLoop);
}

function showResults() {
  const panel = $("resultsPanel");
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
  const p = $("resultsPanel");
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
  $("btnRun").disabled = false;
  setControlsLocked(false);
}

async function runSimulation() {
  if (G.animId) {
    cancelAnimationFrame(G.animId);
    G.animId = null;
  }

  G.floors = +$("slFloors").value;
  G.capacity = +$("slCap").value;
  G.speed = +$("slSpeed").value;
  const arrival = +$("slRate").value;

  buildViz("buildA", 1);
  buildViz("buildB", 2);
  clearKpis();
  hideResults();
  setClock(0);
  setProgress(0);
  setStatus("Computing simulation...");
  $("btnRun").disabled = true;
  setControlsLocked(true);
  $("loadingOverlay").style.display = "flex";

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
    $("loadingOverlay").style.display = "none";
    setStatus("X " + err.message);
    $("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  $("loadingOverlay").style.display = "none";
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
    $("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  setStatus("Animating...");
  requestAnimationFrame(animLoop);
}

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
  lines.push(`Max Wait (s),${a.max_wait},${b.max_wait}`);
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
  $("btnRun").onclick = runSimulation;
});
