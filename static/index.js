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
  floors:   10,
  capacity:  8,
  speed:    20,       // animation speed multiplier
  animId:   null,
  data:     null,     // full JSON from server
};

// Playback cursor
const P = {
  frames:    [],      // [{a: frameA, b: frameB}, ...]
  idx:       0,
  lastTs:    null,
  accMs:     0,
  running:   false,
  firstDraw: true,
};

// Each sim frame represents 60 real sim-seconds.
// At 1× speed → 80 ms per frame  →  ~38 s to watch 8-hour sim
// At 20× speed → 2 ms per frame  →  ~2 s
const MS_PER_FRAME = 80;


// ── Helpers ───────────────────────────────────────────────────────────────

function onSlider(valId, val, suffix) {
  document.getElementById(valId).textContent = val + suffix;
}

function rebuildViz() {
  G.floors   = +document.getElementById("slFloors").value;
  G.capacity = +document.getElementById("slCap").value;
  buildViz("buildA", 1);
  buildViz("buildB", 2);
}

function $(id) { return document.getElementById(id); }

function setStatus(msg)     { $("statusMsg").textContent = msg; }
function setProgress(pct)   {
  $("progFill").style.width  = Math.min(pct, 100) + "%";
  $("progPct").textContent   = pct > 0 ? Math.round(pct) + "%" : "";
}
function setClock(hours)    {
  const h = Math.floor(hours), m = Math.floor((hours % 1) * 60);
  $("simClock").textContent = String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
}

function setKpi(id, val) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("empty");
  el.textContent = val;
}
function clearKpis() {
  ["kw-a","kq-a","ku-a","kw-b","kq-b","ku-b"].forEach(id => {
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

  const floors   = G.floors;
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
  const names  = numElevators === 1 ? ["E-A"]   : ["E-A",  "E-B"];
  const cls    = numElevators === 1 ? ["car-a"]  : ["car-a","car-b"];

  for (let s = 0; s < numElevators; s++) {
    const grp   = ce("div", "shaft-group");
    const lbl   = ce("div", "shaft-label");
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
      `<div class="car-id">${names[s]}</div>` +
      `<div class="car-load" id="${wrapperId}-load-${s}">0/${capacity}</div>`;
    shaft.appendChild(car);

    grp.appendChild(shaft);
    shaftsEl.appendChild(grp);
  }
  wrap.appendChild(shaftsEl);

  // Queue dots column
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
  const car   = $(vizId + "-car-" + shaftIdx);
  const shaft = $(vizId + "-shaft-" + shaftIdx);
  if (!car || !shaft) return;
  const shaftH = shaft.clientHeight;
  const floorH = shaftH / G.floors;
  car.style.height     = Math.max(floorH - 6, 18) + "px";
  car.style.transition = animate ? "bottom 0.22s ease-in-out" : "none";
  car.style.bottom     = ((floor - 1) * floorH + 3) + "px";
}

function setLoad(vizId, shaftIdx, current) {
  const el = $(vizId + "-load-" + shaftIdx);
  if (el) el.textContent = current + "/" + G.capacity;
}

function drawQueue(vizId, floor, count) {
  const el = $(vizId + "-q" + floor);
  if (!el) return;
  el.innerHTML = "";
  const show = Math.min(count, 15);
  for (let i = 0; i < show; i++) el.appendChild(ce("div", "q-dot"));
  if (count > 15) {
    const s = ce("span", "q-more");
    s.textContent = "+" + (count - 15);
    el.appendChild(s);
  }
}


// ── Animation loop ────────────────────────────────────────────────────────

function animLoop(ts) {
  if (!P.running) return;

  if (P.lastTs === null) P.lastTs = ts;
  P.accMs  += (ts - P.lastTs) * G.speed;
  P.lastTs  = ts;

  // Advance frame index by however many frames elapsed wall time covers
  while (P.accMs >= MS_PER_FRAME && P.idx < P.frames.length - 1) {
    P.accMs -= MS_PER_FRAME;
    P.idx++;
  }

  const f  = P.frames[P.idx];
  const fa = f.a, fb = f.b;
  const an = !P.firstDraw;
  P.firstDraw = false;

  // Draw Scenario A
  moveCar("buildA", 0, fa.ef[0], an);
  setLoad("buildA", 0, fa.el[0]);
  for (let i = 1; i <= G.floors; i++) drawQueue("buildA", i, fa.ql[i-1] || 0);

  // Draw Scenario B
  moveCar("buildB", 0, fb.ef[0], an);
  setLoad("buildB", 0, fb.el[0]);
  if (fb.ef.length > 1) { moveCar("buildB", 1, fb.ef[1], an); setLoad("buildB", 1, fb.el[1]); }
  for (let i = 1; i <= G.floors; i++) drawQueue("buildB", i, fb.ql[i-1] || 0);

  // Live KPI numbers — update every frame
  setKpi("kw-a", fa.aw + " s");
  setKpi("kq-a", fa.aq + "");
  setKpi("ku-a", fa.ut + " %");
  setKpi("kw-b", fb.aw + " s");
  setKpi("kq-b", fb.aq + "");
  setKpi("ku-b", fb.ut + " %");

  // Clock + progress
  setClock(fa.t);
  setProgress((P.idx / (P.frames.length - 1)) * 100);

  // Finished?
  if (P.idx >= P.frames.length - 1) {
    P.running  = false;
    G.animId   = null;
    setClock(8);
    setProgress(100);
    setStatus("Simulation complete");
    // Overwrite with final multi-rep KPIs
    const ka = G.data.scenario_a.kpis, kb = G.data.scenario_b.kpis;
    setKpi("kw-a", ka.avg_wait    + " s");   setKpi("kw-b", kb.avg_wait    + " s");
    setKpi("kq-a", ka.avg_queue   + "");     setKpi("kq-b", kb.avg_queue   + "");
    setKpi("ku-a", ka.utilization + " %");   setKpi("ku-b", kb.utilization + " %");
    showResults();
    $("btnRun").disabled = false;
    return;
  }

  G.animId = requestAnimationFrame(animLoop);
}


// ── Run button ────────────────────────────────────────────────────────────

async function runSimulation() {
  if (G.animId) { cancelAnimationFrame(G.animId); G.animId = null; }

  G.floors   = +$("slFloors").value;
  G.capacity = +$("slCap").value;
  G.speed    = +$("slSpeed").value;
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
    return;
  }

  $("loadingOverlay").style.display = "none";
  G.data = data;

  // Zip frames from both scenarios
  const fa = data.scenario_a.frames;
  const fb = data.scenario_b.frames;
  const n  = Math.min(fa.length, fb.length);
  P.frames    = Array.from({ length: n }, (_, i) => ({ a: fa[i], b: fb[i] }));
  P.idx       = 0;
  P.lastTs    = null;
  P.accMs     = 0;
  P.running   = true;
  P.firstDraw = true;

  if (n === 0) {
    setStatus("No frames generated. Try a higher arrival rate.");
    $("btnRun").disabled = false;
    return;
  }

  setStatus("Animating…");
  requestAnimationFrame(animLoop);
}


// ── Results panel ─────────────────────────────────────────────────────────

function showResults() {
  const panel = $("resultsPanel");
  const a  = G.data.scenario_a.kpis;
  const b  = G.data.scenario_b.kpis;
  const ca = G.data.scenario_a.ci;
  const cb = G.data.scenario_b.ci;
  const p  = G.data.params;

  const better = (aWins) =>
    aWins ? '<span class="badge-better">BETTER</span>' : "";

  const row = (label, av, bv, lo) => {
    const aW = lo ? +av <= +bv : +av >= +bv;
    return `<tr>
      <td class="r-metric">${label}</td>
      <td class="r-a">${av} ${better(aW)}</td>
      <td class="r-b">${bv} ${better(!aW)}</td>
    </tr>`;
  };

  panel.innerHTML = `
  <div class="rp-inner">
    <div class="rp-header">
      <div>
        <div class="rp-title">Simulation Results</div>
        <div class="rp-sub">
          M/D/c · ${p.floors} floors · λ=${p.arrival} pax/min ·
          ${p.duration_hr}h · ${p.reps} reps
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
        ${row("Avg Wait Time",     a.avg_wait    + " s",  b.avg_wait    + " s",  true)}
        ${row("Max Wait Time",     a.max_wait    + " s",  b.max_wait    + " s",  true)}
        ${row("Avg Queue Length",  a.avg_queue   + " pax",b.avg_queue   + " pax",true)}
        ${row("Utilization",       a.utilization + " %",  b.utilization + " %",  true)}
        ${row("Passengers Served", a.passengers_served,   b.passengers_served,   false)}
      </tbody>
    </table>

    <div class="ci-block">
      <div class="ci-title">95 % Confidence Intervals (${p.reps} replications)</div>
      <div class="ci-grid">
        <div class="ci-item"><span class="ci-lbl ci-a">A · Wait</span>
          <span class="ci-val">[${ca.wait[0]}, ${ca.wait[1]}] s</span></div>
        <div class="ci-item"><span class="ci-lbl ci-b">B · Wait</span>
          <span class="ci-val">[${cb.wait[0]}, ${cb.wait[1]}] s</span></div>
        <div class="ci-item"><span class="ci-lbl ci-a">A · Queue</span>
          <span class="ci-val">[${ca.queue[0]}, ${ca.queue[1]}] pax</span></div>
        <div class="ci-item"><span class="ci-lbl ci-b">B · Queue</span>
          <span class="ci-val">[${cb.queue[0]}, ${cb.queue[1]}] pax</span></div>
        <div class="ci-item"><span class="ci-lbl ci-a">A · Util</span>
          <span class="ci-val">[${ca.util[0]}, ${ca.util[1]}] %</span></div>
        <div class="ci-item"><span class="ci-lbl ci-b">B · Util</span>
          <span class="ci-val">[${cb.util[0]}, ${cb.util[1]}] %</span></div>
      </div>
    </div>
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
  G.data    = null;
  hideResults();
  clearKpis();
  setClock(0);
  setProgress(0);
  setStatus("Set parameters and press Run");
  buildViz("buildA", 1);
  buildViz("buildB", 2);
  $("btnRun").disabled = false;
}


// ── CSV export ────────────────────────────────────────────────────────────

function downloadCSV() {
  if (!G.data) return;
  const d  = G.data;
  const a  = d.scenario_a.kpis, b  = d.scenario_b.kpis;
  const ca = d.scenario_a.ci,   cb = d.scenario_b.ci;
  const fa = d.scenario_a.frames, fb = d.scenario_b.frames;
  const p  = d.params;

  const L = [];  // rows

  L.push("ELEVATOR SIMULATION RESULTS");
  L.push(`Model,M/D/c Queue`);
  L.push(`Floors,${p.floors}`);
  L.push(`Car Capacity,${p.capacity}`);
  L.push(`Arrival Rate (pax/min),${p.arrival}`);
  L.push(`Sim Duration (hr),${p.duration_hr}`);
  L.push(`Warmup (min),${p.warmup_min}`);
  L.push(`Replications,${p.reps}`);
  L.push(`Dispatch Algorithm,SCAN`);
  L.push(`Queue Discipline,FIFO - No Reneging`);
  L.push("");

  L.push("KPI SUMMARY");
  L.push("Metric,Scenario A (1 Elevator),Scenario B (2 Elevators)");
  L.push(`Avg Wait Time (s),${a.avg_wait},${b.avg_wait}`);
  L.push(`Max Wait Time (s),${a.max_wait},${b.max_wait}`);
  L.push(`Avg Queue Length (pax),${a.avg_queue},${b.avg_queue}`);
  L.push(`Utilization (%),${a.utilization},${b.utilization}`);
  L.push(`Passengers Served,${a.passengers_served},${b.passengers_served}`);
  L.push("");

  L.push("95% CONFIDENCE INTERVALS");
  L.push("Metric,A Lo,A Hi,B Lo,B Hi");
  L.push(`Wait (s),${ca.wait[0]},${ca.wait[1]},${cb.wait[0]},${cb.wait[1]}`);
  L.push(`Queue (pax),${ca.queue[0]},${ca.queue[1]},${cb.queue[0]},${cb.queue[1]}`);
  L.push(`Utilization (%),${ca.util[0]},${ca.util[1]},${cb.util[0]},${cb.util[1]}`);
  L.push("");

  L.push("ANIMATION FRAMES — REPLICATION 1");
  L.push("Sim Hour,A Floor,A Load,A AvgWait(s),A AvgQueue,A Util%,"
       + "B Elev1 Floor,B Elev1 Load,B Elev2 Floor,B Elev2 Load,"
       + "B AvgWait(s),B AvgQueue,B Util%");

  const n = Math.min(fa.length, fb.length);
  for (let i = 0; i < n; i++) {
    const ra = fa[i], rb = fb[i];
    L.push([
      ra.t,
      ra.ef[0], ra.el[0], ra.aw, ra.aq, ra.ut,
      rb.ef[0], rb.el[0],
      rb.ef[1] ?? "", rb.el[1] ?? "",
      rb.aw, rb.aq, rb.ut,
    ].join(","));
  }

  const blob = new Blob([L.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
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
  $("btnRun").onclick = runSimulation;
});