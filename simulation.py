"""
simulation.py  —  M/D/c Queue Elevator Simulation
==================================================

Queue Model
-----------
  M  Poisson arrivals        inter-arrival ~ Exp(1/λ)
  D  Deterministic service   travel = n_floors × 2.5 s  +  dwell 5 s/stop
  c  c parallel servers      SCAN dispatch (bidirectional sweep)

Properties
----------
  FIFO within each floor queue
  No reneging, no balking
  Unlimited buffer
  Warmup period discarded from statistics (steady-state only)

Output
------
  run_both(floors, capacity, arrival_per_min)
      Returns a dict with scenario_a and scenario_b, each containing:
        kpis    – mean KPIs over NUM_REPS replications
        ci      – 95 % confidence intervals
        frames  – animation snapshots from rep 0 (one per FRAME_INTERVAL sim-s)
"""

import simpy, random, numpy as np
from collections import deque
from dataclasses import dataclass
from typing import List, Optional, Callable
from scipy import stats as sp_stats

# ── Fixed constants ────────────────────────────────────────────────────────
TRAVEL_SPEED   = 2.5        # seconds per floor
DOOR_DWELL     = 5.0        # seconds per stop
WARMUP         = 10 * 60    # 10-minute warmup  →  discarded from KPIs
SIM_DURATION   = 8 * 3600   # 8-hour measurement window
NUM_REPS       = 5          # replications for CI
BASE_SEED      = 42
FRAME_INTERVAL = 60.0       # one animation snapshot per simulated minute
                             # 8 h × 60 = 480 frames per scenario


# ── Data model ─────────────────────────────────────────────────────────────

@dataclass
class Passenger:
    arrival_time : float
    origin       : int
    dest         : int
    board_time   : float = 0.0
    exit_time    : float = 0.0

    @property
    def wait(self):            return self.board_time - self.arrival_time
    @property
    def sojourn(self):         return self.exit_time  - self.arrival_time


# ── Elevator  (SCAN dispatch) ──────────────────────────────────────────────

class Elevator:
    """
    SCAN algorithm:
      • Travel in current direction, stopping at every pending floor.
      • When no more pending floors ahead, reverse.
      • Guarantees every passenger is served within 2 full sweeps (no starvation).
    """

    def __init__(self, env, eid, num_floors, capacity, floor_queues):
        self.env          = env
        self.eid          = eid
        self.num_floors   = num_floors
        self.capacity     = capacity
        self.floor_queues = floor_queues   # shared list[deque[Passenger]]
        self.floor        = 1
        self.direction    = 1              # +1 up  /  -1 down
        self.riders: List[Passenger] = []
        self.busy_time    = 0.0            # post-warmup active seconds
        env.process(self._run())

    # ── Pending-work helpers ───────────────────────────────────────────

    def _pending(self):
        s = set()
        for f in range(1, self.num_floors + 1):
            if self.floor_queues[f - 1]:
                s.add(f)
        for r in self.riders:
            s.add(r.dest)
        return s

    def _next_target(self):
        pending = self._pending()
        if not pending:
            return None
        if self.direction == 1:
            ahead = [f for f in pending if f > self.floor]
            if ahead:   return min(ahead)
            self.direction = -1
            behind = [f for f in pending if f < self.floor]
            return max(behind) if behind else None
        else:
            ahead = [f for f in pending if f < self.floor]
            if ahead:   return max(ahead)
            self.direction = 1
            behind = [f for f in pending if f > self.floor]
            return min(behind) if behind else None

    # ── SimPy coroutines ───────────────────────────────────────────────

    def _travel(self, target):
        dist = abs(target - self.floor)
        if dist == 0:
            return
        t0 = self.env.now
        yield self.env.timeout(dist * TRAVEL_SPEED)
        if self.env.now > WARMUP:
            self.busy_time += self.env.now - max(t0, float(WARMUP))
        self.direction = 1 if target > self.floor else -1
        self.floor = target

    def _service(self):
        idx     = self.floor - 1
        leaving = [r for r in self.riders if r.dest == self.floor]
        for r in leaving:
            self.riders.remove(r)
            r.exit_time = self.env.now
        q = self.floor_queues[idx]
        boarded = 0
        while q and len(self.riders) < self.capacity:
            p = q.popleft();  p.board_time = self.env.now
            self.riders.append(p);  boarded += 1
        if leaving or boarded:
            t0 = self.env.now
            yield self.env.timeout(DOOR_DWELL)
            if self.env.now > WARMUP:
                self.busy_time += self.env.now - max(t0, float(WARMUP))

    def _run(self):
        while True:
            # Serve current floor first when possible.
            here_q = self.floor_queues[self.floor - 1]
            need_drop = any(r.dest == self.floor for r in self.riders)
            can_board = bool(here_q) and len(self.riders) < self.capacity
            if need_drop or can_board:
                yield from self._service()
                continue

            target = self._next_target()
            if target is None:
                yield self.env.timeout(1.0)
                continue
            yield from self._travel(target)
            yield from self._service()


# ── Single replication ─────────────────────────────────────────────────────

def _one_rep(floors, capacity, rate_per_sec, num_elevators, seed,
             on_frame: Optional[Callable] = None):

    rng           = random.Random(seed)
    env           = simpy.Environment()
    floor_queues  = [deque() for _ in range(floors)]
    records       : List[Passenger] = []
    in_warmup     = [True]
    q_samples     : List[float]     = []

    elevators = [Elevator(env, i, floors, capacity, floor_queues)
                 for i in range(num_elevators)]

    # Poisson arrivals  [the M]
    def arrivals():
        while True:
            yield env.timeout(rng.expovariate(rate_per_sec))
            o = rng.randint(1, floors)
            d = rng.randint(1, floors)
            while d == o:
                d = rng.randint(1, floors)
            p = Passenger(env.now, o, d)
            floor_queues[o - 1].append(p)
            if not in_warmup[0]:
                records.append(p)

    # Queue-length sampler (every 30 s)
    def sampler():
        while True:
            yield env.timeout(30.0)
            if not in_warmup[0]:
                q_samples.append(float(sum(len(q) for q in floor_queues)))

    def end_warmup():
        yield env.timeout(WARMUP)
        in_warmup[0] = False

    # Animation frame recorder
    def recorder():
        yield env.timeout(WARMUP)
        while True:
            yield env.timeout(FRAME_INTERVAL)
            if on_frame is None:
                continue
            done  = [p for p in records if p.exit_time > 0]
            waits = [p.wait for p in done]
            elapsed = max(env.now - WARMUP, 1.0)
            on_frame({
                "t":  round((env.now - WARMUP) / 3600.0, 4),   # hours
                "ef": [e.floor      for e in elevators],         # floor positions
                "el": [len(e.riders) for e in elevators],        # loads
                "ql": [len(q)        for q in floor_queues],     # queues per floor
                # live running KPIs
                "aw": round(float(np.mean(waits)), 1)           if waits     else 0.0,
                "aq": round(float(np.mean(q_samples)), 2)       if q_samples else 0.0,
                "ut": round(float(np.mean([
                    min(e.busy_time / elapsed * 100, 100)
                    for e in elevators])), 1),
            })

    env.process(arrivals())
    env.process(sampler())
    env.process(end_warmup())
    env.process(recorder())
    env.run(until=WARMUP + SIM_DURATION)

    done  = [p for p in records if p.exit_time > 0]
    waits = [p.wait for p in done]
    utils = [min(e.busy_time / SIM_DURATION * 100, 100) for e in elevators]

    return {
        "avg_wait":          float(np.mean(waits))     if waits     else 0.0,
        "max_wait":          float(np.max(waits))      if waits     else 0.0,
        "avg_queue":         float(np.mean(q_samples)) if q_samples else 0.0,
        "utilization":       float(np.mean(utils)),
        "passengers_served": len(done),
    }


# ── Confidence interval ────────────────────────────────────────────────────

def _ci95(vals):
    n = len(vals)
    if n < 2:
        v = vals[0] if vals else 0.0
        return [round(v,3), round(v,3)]
    m, se = float(np.mean(vals)), float(sp_stats.sem(vals))
    t = float(sp_stats.t.ppf(0.975, df=n-1))
    return [round(m - se*t, 3), round(m + se*t, 3)]


# ── Public API ─────────────────────────────────────────────────────────────

def run_scenario(floors, capacity, arrival_per_min, num_elevators):
    rate = max(0.001, float(arrival_per_min)) / 60.0
    wait_l, queue_l, util_l, served_l, max_l = [], [], [], [], []
    frames = []

    for rep in range(NUM_REPS):
        buf = []
        r = _one_rep(floors, capacity, rate, num_elevators,
                     seed=BASE_SEED + rep,
                     on_frame=buf.append if rep == 0 else None)
        wait_l.append(r["avg_wait"]);    queue_l.append(r["avg_queue"])
        util_l.append(r["utilization"]); served_l.append(r["passengers_served"])
        max_l.append(r["max_wait"])
        if rep == 0:
            frames = buf

    return {
        "kpis": {
            "avg_wait":          round(float(np.mean(wait_l)),  2),
            "max_wait":          round(float(np.max(max_l)),    2),
            "avg_queue":         round(float(np.mean(queue_l)), 3),
            "utilization":       round(float(np.mean(util_l)),  2),
            "passengers_served": int(round(float(np.mean(served_l)))),
        },
        "ci": {
            "wait":  _ci95(wait_l),
            "queue": _ci95(queue_l),
            "util":  _ci95(util_l),
        },
        "frames": frames,
    }


def run_both(floors, capacity, arrival_per_min):
    floors   = max(4,   min(20,    int(floors)))
    capacity = max(2,   min(20,    int(capacity)))
    arrival  = max(1.0, min(300.0, float(arrival_per_min)))
    return {
        "scenario_a": run_scenario(floors, capacity, arrival, 1),
        "scenario_b": run_scenario(floors, capacity, arrival, 2),
        "params": {
            "floors": floors, "capacity": capacity, "arrival": arrival,
            "reps": NUM_REPS, "warmup_min": WARMUP // 60,
            "duration_hr": SIM_DURATION // 3600,
        },
    }

