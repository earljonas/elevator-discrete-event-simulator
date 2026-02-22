// ── State ─────────────────────────────────────────────────────────────────
let NUM_FLOORS = 10;
let CAPACITY   = 8;

// ── Build the whole building visual for one pane ──────────────────────────
// id          : e.g. 'buildA'
// numElevators: 1 or 2
// floors      : floor count
// capacity    : for the load text
function buildViz(id, numElevators, floors, capacity) {
  const wrap = document.getElementById(id);
  wrap.innerHTML = '';

  // 1. Floor number labels (top = highest)
  const labelCol = document.createElement('div');
  labelCol.className = 'floor-labels';
  for (let f = floors; f >= 1; f--) {
    const d = document.createElement('div');
    d.className   = 'floor-label';
    d.textContent = f;
    labelCol.appendChild(d);
  }
  wrap.appendChild(labelCol);

  // 2. Elevator shaft(s)
  const shaftsWrap = document.createElement('div');
  shaftsWrap.className = 'shafts';

  const names    = numElevators === 1 ? ['E-A'] : ['E-A', 'E-B'];
  const carClass = numElevators === 1 ? ['car-a'] : ['car-a', 'car-b'];

  for (let s = 0; s < numElevators; s++) {
    const grp = document.createElement('div');
    grp.className = 'shaft-group';

    const lbl = document.createElement('div');
    lbl.className   = 'shaft-label';
    lbl.textContent = names[s];
    grp.appendChild(lbl);

    const shaft = document.createElement('div');
    shaft.className = 'shaft';
    shaft.id        = id + '-shaft-' + s;

    // Floor grid lines background
    const grid = document.createElement('div');
    grid.className = 'shaft-grid';
    for (let f = 0; f < floors; f++) {
      const line = document.createElement('div');
      line.className = 'shaft-grid-line';
      grid.appendChild(line);
    }
    shaft.appendChild(grid);

    // Elevator car — one element per elevator, moved via bottom
    const car = document.createElement('div');
    car.id        = id + '-car-' + s;
    car.className = 'elevator-car ' + carClass[s];
    car.style.transition = 'none';   // no animation on first draw
    car.innerHTML = `
      <div class="car-id">${names[s]}</div>
      <div class="car-load" id="${id}-load-${s}">0/${capacity}</div>
    `;
    shaft.appendChild(car);
    grp.appendChild(shaft);
    shaftsWrap.appendChild(grp);
  }
  wrap.appendChild(shaftsWrap);

  // 3. Queue waiting area column
  const queueCol = document.createElement('div');
  queueCol.className = 'queue-col';

  const qhdr = document.createElement('div');
  qhdr.className   = 'queue-col-header';
  qhdr.textContent = 'WAITING';
  queueCol.appendChild(qhdr);

  // Rows: top = highest floor, matching the label column order
  for (let f = floors; f >= 1; f--) {
    const row = document.createElement('div');
    row.className = 'queue-floor';
    row.id        = id + '-q' + f;
    queueCol.appendChild(row);
  }
  wrap.appendChild(queueCol);

  // Position cars after layout (needs real pixel heights)
  requestAnimationFrame(() => {
    for (let s = 0; s < numElevators; s++) {
      setCar(id, s, 1, floors, false);
    }
  });
}

// ── Move an elevator car smoothly ─────────────────────────────────────────
// floor is 1-indexed. animate=false for instant jump, true for CSS transition.
function setCar(id, shaftIdx, floor, floors, animate) {
  const car   = document.getElementById(id + '-car-'   + shaftIdx);
  const shaft = document.getElementById(id + '-shaft-' + shaftIdx);
  if (!car || !shaft) return;

  const shaftH   = shaft.clientHeight;
  const floorH   = shaftH / floors;
  const carH     = Math.max(floorH - 6, 18);  // minimum 18px so text fits

  car.style.height     = carH + 'px';
  car.style.transition = animate ? 'bottom 0.35s ease-in-out' : 'none';
  car.style.bottom     = ((floor - 1) * floorH + 3) + 'px';
}

// ── Update load text inside a car ─────────────────────────────────────────
function setLoad(id, shaftIdx, current, max) {
  const el = document.getElementById(id + '-load-' + shaftIdx);
  if (el) el.textContent = current + '/' + max;
}

// ── Update waiting dots for one floor ────────────────────────────────────
function setQueue(id, floor, count) {
  const el = document.getElementById(id + '-q' + floor);
  if (!el) return;
  el.innerHTML = '';
  const show = Math.min(count, 12);
  for (let i = 0; i < show; i++) {
    const d = document.createElement('div');
    d.className = 'q-dot';
    el.appendChild(d);
  }
  if (count > 12) {
    const m = document.createElement('span');
    m.className   = 'q-more';
    m.textContent = '+' + (count - 12);
    el.appendChild(m);
  }
}

// ── Rebuild when slider changes ───────────────────────────────────────────
function onFloorsChange(val) {
  document.getElementById('valFloors').textContent = val;
  NUM_FLOORS = parseInt(val);
  rebuildAll();
}
function onCapChange(val) {
  document.getElementById('valCap').textContent = val;
  CAPACITY = parseInt(val);
  rebuildAll();
}
function rebuildAll() {
  buildViz('buildA', 1, NUM_FLOORS, CAPACITY);
  buildViz('buildB', 2, NUM_FLOORS, CAPACITY);
  // Demo positions — remove once simulation drives them
  setTimeout(demoPositions, 50);
}

// ── Demo static positions so the UI isn't empty ───────────────────────────
// Replace this entirely when simulation output drives setCar/setQueue.
function demoPositions() {
  // Scenario A: single elevator mid-building
  const midA = Math.ceil(NUM_FLOORS / 2);
  setCar  ('buildA', 0, midA, NUM_FLOORS, true);
  setLoad ('buildA', 0, 3, CAPACITY);
  setQueue('buildA', Math.max(1, midA - 2), 5);
  setQueue('buildA', Math.min(NUM_FLOORS, midA + 3), 2);

  // Scenario B: two elevators split top/bottom
  const topB = Math.round(NUM_FLOORS * 0.75);
  const botB = Math.round(NUM_FLOORS * 0.25);
  setCar  ('buildB', 0, topB, NUM_FLOORS, true);
  setLoad ('buildB', 0, 4, CAPACITY);
  setCar  ('buildB', 1, botB, NUM_FLOORS, true);
  setLoad ('buildB', 1, 2, CAPACITY);
  setQueue('buildB', Math.max(1, topB - 1), 3);
  setQueue('buildB', Math.min(NUM_FLOORS, botB + 2), 4);
}

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  buildViz('buildA', 1, NUM_FLOORS, CAPACITY);
  buildViz('buildB', 2, NUM_FLOORS, CAPACITY);
  setTimeout(demoPositions, 60);
});