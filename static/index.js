// =============================================================================
//  ElevaSim — index.js
//
//  Flow:
//    1. User clicks Run
//    2. POST /run  →  Flask runs SimPy  (~5-15 s)  →  returns full frame data
//    3. JS plays back frames at chosen speed  →  live-looking animation
//    4. Numbers (wait, queue, util) update every frame
//    5. Animation ends  →  results panel slides up  →  CSV download available
// =============================================================================

// ── Global config / state ─────────────────────────────────────────────────
const G = {
  floors: 10,
  capacity: 8,
  speed: 20,       // animation speed multiplier
  animId: null,
  data: null,     // full JSON from server
};

// Playback cursor
const P = {
  frames: [],      // [{a: frameA, b: frameB}, ...]
  idx: 0,
  lastTs: null,
  accMs: 0,
  running: false,
  firstDraw: true,
};

// Each sim frame represents 10 real sim-seconds (FRAME_INTERVAL = 10).
// At 1× speed → 80 ms per frame  →  ~230 s to watch 8-hour sim
// At 20× speed → 4 ms per frame  →  ~11.5 s
const MS_PER_FRAME = 80;


// ── Helpers ───────────────────────────────────────────────────────────────

function onSlider(valId, val, suffix) {
  document.getElementById(valId).textContent = val + suffix;
}

function rebuildViz() {
  G.floors = +document.getElementById("slFloors").value;
  G.capacity = +document.getElementById("slCap").value;
  buildViz("buildA", 1);
  buildViz("buildB", 2);
}

function $(id) { return document.getElementById(id); }

function setStatus(msg) { $("statusMsg").textContent = msg; }
function setControlsLocked(locked) {
  ["slFloors", "slCap", "slRate"].forEach(id => {
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
  const h = Math.floor(hours), m = Math.floor((hours % 1) * 60);
  $("simClock").textContent = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// ── Human-readable time formatting ────────────────────────────────────────
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

function setKpi(id, val) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("empty");
  el.textContent = val;
}
function clearKpis() {
  ["kw-a", "kq-a", "ku-a", "kw-b", "kq-b", "ku-b"].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.classList.add("empty");
    el.textContent = "—";
  });
}


// ── Building visualiser ───────────────────────────────────────────────────

function buildViz(wrapperId, numElevators) {
  const wrap = $(wrapperId);
  if (!wrap) return;
  wrap.innerHTML = "";

  const floors = G.floors;
  const capacity = G.capacity;

  // Floor labels
  const lblCol = ce("div", "floor-labels");
  for (let f = floors; f >= 1; f--) {
    const d = ce("div", "floor-label");
    d.textContent = f;
    lblCol.appendChild(d);
  }
  wrap.appendChild(lblCol);

  // Shaft(s)
  const shaftsEl = ce("div", "shafts");
  const names = numElevators === 1 ? ["E-A"] : ["E-A", "E-B"];
  const cls = numElevators === 1 ? ["car-a"] : ["car-a", "car-b"];

  for (let s = 0; s < numElevators; s++) {
    const grp = ce("div", "shaft-group");
    const lbl = ce("div", "shaft-label");
    lbl.textContent = names[s];
    grp.appendChild(lbl);

    const shaft = ce("div", "shaft");
    shaft.id = wrapperId + "-shaft-" + s;

    // Grid lines
    const grid = ce("div", "shaft-grid");
    for (let i = 0; i < floors; i++) grid.appendChild(ce("div", "shaft-grid-line"));
    shaft.appendChild(grid);

    // Car element (positioned via CSS bottom)
    const car = ce("div", "elevator-car " + cls[s]);
    car.id = wrapperId + "-car-" + s;
    car.innerHTML =
      `<div class="car-dir" id="${wrapperId}-dir-${s}">—</div>` +
      `<div class="car-id">${names[s]}</div>` +
      `<div class="car-load" id="${wrapperId}-load-${s}">0/${capacity}</div>`;
    shaft.appendChild(car);

    grp.appendChild(shaft);
    shaftsEl.appendChild(grp);
  }
  wrap.appendChild(shaftsEl);

  // Queue column
  const qcol = ce("div", "queue-col");
  const qhdr = ce("div", "queue-col-hdr");
  qhdr.textContent = "QUEUE";
  qcol.appendChild(qhdr);
  for (let f = floors; f >= 1; f--) {
    const row = ce("div", "queue-row");
    row.id = wrapperId + "-q" + f;
    qcol.appendChild(row);
  }
  wrap.appendChild(qcol);

  // Initial car position
  requestAnimationFrame(() => {
    for (let s = 0; s < numElevators; s++) moveCar(wrapperId, s, 1, false);
  });
}

function ce(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}


// ── Render primitives ─────────────────────────────────────────────────────

function moveCar(vizId, shaftIdx, floor, animate) {
  const car = $(vizId + "-car-" + shaftIdx);
  const shaft = $(vizId + "-shaft-" + shaftIdx);
  if (!car || !shaft) return;
  const shaftH = shaft.clientHeight;
  const floorH = shaftH / G.floors;
  car.style.height = Math.max(floorH - 6, 18) + "px";
  const frameMs = MS_PER_FRAME / Math.max(G.speed, 1);
  const travelMs = Math.max(30, Math.min(180, frameMs * 0.85));
  car.style.transition = (animate && frameMs >= 35)
    ? `bottom ${travelMs}ms linear`
    : "none";
  car.style.bottom = ((floor - 1) * floorH + 3) + "px";
}

function setDirection(vizId, shaftIdx, dir) {
  const el = $(vizId + "-dir-" + shaftIdx);
  if (!el) return;
  el.textContent = dir === 1 ? "▲" : dir === -1 ? "▼" : "—";
  el.className = "car-dir" + (dir === 1 ? " dir-up" : dir === -1 ? " dir-down" : "");
}

function setLoad(vizId, shaftIdx, current) {
  const el = $(vizId + "-load-" + shaftIdx);
  if (el) el.textContent = current + "/" + G.capacity;
}

function drawQueue(vizId, floor, count) {
  const el = $(vizId + "-q" + floor);
  if (!el) return;
  el.innerHTML = "";

  if (count === 0) return;

  if (count <= 20) {
    // Show individual dots for small queues
    for (let i = 0; i < count; i++) el.appendChild(ce("div", "q-dot"));
  } else {
    // Compact bar + number for large queues
    const bar = ce("div", "q-bar");
    const maxWidth = 80; // percent
    const ratio = Math.min(count / 100, 1); // cap visual at 100
    bar.style.width = Math.max(ratio * maxWidth, 10) + "%";
    el.appendChild(bar);
    const lbl = ce("span", "q-count");
    lbl.textContent = count.toLocaleString();
    el.appendChild(lbl);
  }
}


// ── Animation loop ────────────────────────────────────────────────────────

function animLoop(ts) {
  if (!P.running) return;

  if (P.lastTs === null) P.lastTs = ts;
  P.accMs += (ts - P.lastTs) * G.speed;
  P.lastTs = ts;

  // Advance frame index by however many frames elapsed wall time covers
  while (P.accMs >= MS_PER_FRAME && P.idx < P.frames.length - 1) {
    P.accMs -= MS_PER_FRAME;
    P.idx++;
  }

  const f = P.frames[P.idx];
  const fa = f.a, fb = f.b;
  const an = !P.firstDraw;
  P.firstDraw = false;

  // Draw Scenario A
  moveCar("buildA", 0, fa.ef[0], an);
  setLoad("buildA", 0, fa.el[0]);
  setDirection("buildA", 0, fa.ed ? fa.ed[0] : 0);
  for (let i = 1; i <= G.floors; i++) drawQueue("buildA", i, fa.ql[i - 1] || 0);

  // Draw Scenario B
  moveCar("buildB", 0, fb.ef[0], an);
  setLoad("buildB", 0, fb.el[0]);
  setDirection("buildB", 0, fb.ed ? fb.ed[0] : 0);
  if (fb.ef.length > 1) {
    moveCar("buildB", 1, fb.ef[1], an);
    setLoad("buildB", 1, fb.el[1]);
    setDirection("buildB", 1, fb.ed ? fb.ed[1] : 0);
  }
  for (let i = 1; i <= G.floors; i++) drawQueue("buildB", i, fb.ql[i - 1] || 0);

  // Live KPI numbers — human-readable format
  setKpi("kw-a", fmtWait(fa.aw));
  setKpi("kq-a", fmtQueue(fa.aq));
  setKpi("ku-a", fa.ut + " %");
  setKpi("kw-b", fmtWait(fb.aw));
  setKpi("kq-b", fmtQueue(fb.aq));
  setKpi("ku-b", fb.ut + " %");

  // Clock + progress
  setClock(fa.t);
  setProgress((P.idx / (P.frames.length - 1)) * 100);

  // Finished?
  if (P.idx >= P.frames.length - 1) {
    P.running = false;
    G.animId = null;
    setClock(8);
    setProgress(100);
    setStatus("Simulation complete");
    // Overwrite with final multi-rep KPIs (human-readable)
    const ka = G.data.scenario_a.kpis, kb = G.data.scenario_b.kpis;
    setKpi("kw-a", fmtWait(ka.avg_wait)); setKpi("kw-b", fmtWait(kb.avg_wait));
    setKpi("kq-a", fmtQueue(ka.avg_queue)); setKpi("kq-b", fmtQueue(kb.avg_queue));
    setKpi("ku-a", ka.utilization + " %"); setKpi("ku-b", kb.utilization + " %");
    showResults();
    $("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  G.animId = requestAnimationFrame(animLoop);
}


// ── Run button ────────────────────────────────────────────────────────────

async function runSimulation() {
  if (G.animId) { cancelAnimationFrame(G.animId); G.animId = null; }

  G.floors = +$("slFloors").value;
  G.capacity = +$("slCap").value;
  G.speed = +$("slSpeed").value;
  const arrival = +$("slRate").value;

  // Reset UI
  buildViz("buildA", 1);
  buildViz("buildB", 2);
  clearKpis();
  hideResults();
  setClock(0);
  setProgress(0);
  setStatus("Computing simulation…");
  $("btnRun").disabled = true;
  setControlsLocked(true);
  $("loadingOverlay").style.display = "flex";

  // ── POST /run ────────────────────────────────────────────────────────
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
    setStatus("✗ " + err.message);
    $("btnRun").disabled = false;
    setControlsLocked(false);
    return;
  }

  $("loadingOverlay").style.display = "none";
  G.data = data;

  // Zip frames from both scenarios
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

  setStatus("Animating…");
  requestAnimationFrame(animLoop);
}


// ── Results panel ─────────────────────────────────────────────────────────

function showResults() {
  const panel = $("resultsPanel");
  const a = G.data.scenario_a.kpis;
  const b = G.data.scenario_b.kpis;
  const p = G.data.params;

  const better = (aWins) =>
    aWins ? '<span class="badge-better">BETTER</span>' : "";

  const row = (label, avText, bvText, avNum, bvNum, lowerIsBetter) => {
    const aW = lowerIsBetter ? avNum <= bvNum : avNum >= bvNum;
    return `<tr>
      <td class="r-metric">${label}</td>
      <td class="r-a">${avText} ${better(aW)}</td>
      <td class="r-b">${bvText} ${better(!aW)}</td>
    </tr>`;
  };

  panel.innerHTML = `
  <div class="rp-inner">
    <div class="rp-header">
      <div>
        <div class="rp-title">Simulation Results</div>
        <div class="rp-sub">
          M/D/c · ${p.floors} floors · λ=${p.arrival} pax/min ·
          ${p.duration_hr}h
        </div>
      </div>
      <div class="rp-actions">
        <button class="btn-csv"      onclick="downloadCSV()">⬇ CSV</button>
        <button class="btn-tryagain" onclick="tryAgain()">↺ Try Again</button>
      </div>
    </div>

    <table class="rtable">
      <thead><tr>
        <th>Metric</th>
        <th class="th-a">A — 1 Elevator</th>
        <th class="th-b">B — 2 Elevators</th>
      </tr></thead>
      <tbody>
        ${row("Avg Wait Time", fmtWait(a.avg_wait), fmtWait(b.avg_wait), a.avg_wait, b.avg_wait, true)}
        ${row("Max Wait Time", fmtWait(a.max_wait), fmtWait(b.max_wait), a.max_wait, b.max_wait, true)}
        ${row("Avg Queue Length", fmtQueue(a.avg_queue) + " pax", fmtQueue(b.avg_queue) + " pax", a.avg_queue, b.avg_queue, true)}
        ${row("Utilization", a.utilization + " %", b.utilization + " %", a.utilization, b.utilization, false)}
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
  if (G.animId) { cancelAnimationFrame(G.animId); G.animId = null; }
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


// ── CSV export ────────────────────────────────────────────────────────────

function downloadCSV() {
  if (!G.data) return;
  const d = G.data;
  const a = d.scenario_a.kpis, b = d.scenario_b.kpis;
  const fa = d.scenario_a.frames, fb = d.scenario_b.frames;
  const p = d.params;

  const L = [];  // rows

  L.push("ELEVATOR SIMULATION RESULTS");
  L.push(`Model,M/D/c Queue`);
  L.push(`Floors,${p.floors}`);
  L.push(`Car Capacity,${p.capacity}`);
  L.push(`Arrival Rate (pax/min),${p.arrival}`);
  L.push(`Sim Duration (hr),${p.duration_hr}`);
  L.push(`Dispatch Algorithm,SCAN (nearest-call coordination)`);
  L.push(`Queue Discipline,FIFO - No Reneging`);
  L.push(`Boarding,Direction-aware`);
  L.push("");

  L.push("KPI SUMMARY");
  L.push("Metric,Scenario A (1 Elevator),Scenario B (2 Elevators)");
  L.push(`Avg Wait Time (s),${a.avg_wait},${b.avg_wait}`);
  L.push(`Max Wait Time (s),${a.max_wait},${b.max_wait}`);
  L.push(`Avg Queue Length (pax),${a.avg_queue},${b.avg_queue}`);
  L.push(`Utilization (%),${a.utilization},${b.utilization}`);
  L.push(`Passengers Served,${a.passengers_served},${b.passengers_served}`);
  L.push("");

  L.push("ANIMATION FRAMES");
  L.push("Sim Hour,A Floor,A Dir,A Load,A AvgWait(s),A AvgQueue,A Util%,"
    + "B Elev1 Floor,B Elev1 Dir,B Elev1 Load,B Elev2 Floor,B Elev2 Dir,B Elev2 Load,"
    + "B AvgWait(s),B AvgQueue,B Util%");

  const n = Math.min(fa.length, fb.length);
  for (let i = 0; i < n; i++) {
    const ra = fa[i], rb = fb[i];
    L.push([
      ra.t,
      ra.ef[0], ra.ed ? ra.ed[0] : "", ra.el[0], ra.aw, ra.aq, ra.ut,
      rb.ef[0], rb.ed ? rb.ed[0] : "", rb.el[0],
      rb.ef[1] ?? "", rb.ed ? (rb.ed[1] ?? "") : "", rb.el[1] ?? "",
      rb.aw, rb.aq, rb.ut,
    ].join(","));
  }

  const blob = new Blob([L.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a_el = Object.assign(document.createElement("a"), {
    href: url, download: `elevasim_${p.floors}fl_${p.arrival}pax.csv`
  });
  a_el.click();
  URL.revokeObjectURL(url);
}


// ── Init ──────────────────────────────────────────────────────────────────

window.addEventListener("load", () => {
  buildViz("buildA", 1);
  buildViz("buildB", 2);
  setControlsLocked(false);
  $("btnRun").onclick = runSimulation;
});


