"""
simulation.py  —  M/D/c Queue Elevator Simulation
==================================================

Queue Model
-----------
  M  Poisson arrivals        inter-arrival ~ Exp(1/λ)
  D  Deterministic service   travel = n_floors × 2.5 s  +  dwell 5 s/stop
  c  c parallel servers      SCAN dispatch (nearest-call coordination)

Properties
----------
  FIFO within each floor queue
  Direction-aware boarding (passengers only board if going same direction)
  Nearest-call dispatch for multi-elevator coordination
  No reneging, no balking
  Unlimited buffer
  No warmup — statistics collected from t=0

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
SIM_DURATION   = 8 * 3600   # 8-hour simulation
NUM_REPS       = 5          # replications for CI
BASE_SEED      = 42
FRAME_INTERVAL = 10.0       # one animation snapshot every 10 sim-seconds
                             # 8 h = 2880 frames per scenario


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


# ── Elevator  (SCAN dispatch + nearest-call coordination) ─────────────────

class Elevator:
    """
    SCAN algorithm with nearest-call coordination:
      • Travel in current direction, stopping at every pending floor.
      • When no more pending floors ahead, reverse.
      • For hall calls, only claim a floor if this elevator is the nearest
        (prevents multiple elevators from racing to the same call).
      • Direction-aware boarding: passengers only board if their destination
        is in the elevator's current travel direction.
    """

    def __init__(self, env, eid, num_floors, capacity, floor_queues,
                 all_elevators):
        self.env            = env
        self.eid            = eid
        self.num_floors     = num_floors
        self.capacity       = capacity
        self.floor_queues   = floor_queues   # shared list[deque[Passenger]]
        self.all_elevators  = all_elevators  # reference to full elevator list
        self.floor          = 1
        self.direction      = 1              # +1 up  /  -1 down
        self.riders: List[Passenger] = []
        self.busy_time      = 0.0            # active seconds
        env.process(self._run())

    # ── Pending-work helpers ───────────────────────────────────────────

    def _pending(self):
        s = set()
        # Always include destinations of current riders
        for r in self.riders:
            s.add(r.dest)
        # For hall calls: only claim the floor if this elevator is nearest
        for f in range(1, self.num_floors + 1):
            if not self.floor_queues[f - 1]:
                continue
            my_dist = abs(self.floor - f)
            nearest = True
            for other in self.all_elevators:
                if other is self:
                    continue
                other_dist = abs(other.floor - f)
                if other_dist < my_dist:
                    nearest = False
                    break
                # Tie-break: lower elevator id wins
                if other_dist == my_dist and other.eid < self.eid:
                    nearest = False
                    break
            if nearest:
                s.add(f)
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
            yield self.env.timeout(1.0)
            return
        t0 = self.env.now
        # Set direction before travel
        self.direction = 1 if target > self.floor else -1
        yield self.env.timeout(dist * TRAVEL_SPEED)
        self.busy_time += self.env.now - t0
        self.floor = target

    def _service(self):
        idx     = self.floor - 1
        # Drop off passengers whose destination is this floor
        leaving = [r for r in self.riders if r.dest == self.floor]
        for r in leaving:
            self.riders.remove(r)
            r.exit_time = self.env.now
        # Board passengers going in the elevator's direction (FIFO)
        q = self.floor_queues[idx]
        boarded = 0
        # Scan queue and pick matching-direction passengers
        remaining = deque()
        while q and len(self.riders) < self.capacity:
            p = q.popleft()
            going_up = p.dest > self.floor
            if (self.direction == 1 and going_up) or \
               (self.direction == -1 and not going_up):
                p.board_time = self.env.now
                self.riders.append(p)
                boarded += 1
            else:
                remaining.append(p)
        # Put non-matching passengers back at the front of the queue
        remaining.extend(q)
        self.floor_queues[idx] = remaining

        if leaving or boarded:
            t0 = self.env.now
            yield self.env.timeout(DOOR_DWELL)
            self.busy_time += self.env.now - t0

    def _run(self):
        while True:
            # Serve current floor first when possible
            here_q = self.floor_queues[self.floor - 1]
            need_drop = any(r.dest == self.floor for r in self.riders)
            
            # If we arrived empty at a floor with waiting passengers, 
            # adopt their direction so we can board them instead of getting stuck!
            if not self.riders and here_q and not need_drop:
                first_waiter = here_q[0]
                self.direction = 1 if first_waiter.dest > self.floor else -1
            
            # Check if any queued passenger matches current direction
            can_board = False
            if here_q and len(self.riders) < self.capacity:
                for p in here_q:
                    going_up = p.dest > self.floor
                    if (self.direction == 1 and going_up) or \
                       (self.direction == -1 and not going_up):
                        can_board = True
                        break

            # Only yield _service if we actually drop or board someone
            if need_drop or can_board:
                t_before = self.env.now
                yield from self._service()
                # If service took no time (e.g. queue mutated), prevent infinite loop
                if self.env.now == t_before:
                    yield self.env.timeout(1.0)
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
    q_samples     : List[float]     = []

    # Create elevators with shared reference list
    all_elevators: List[Elevator] = []
    for i in range(num_elevators):
        e = Elevator(env, i, floors, capacity, floor_queues, all_elevators)
        all_elevators.append(e)

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
            records.append(p)

    # Queue-length sampler (every 30 s)
    def sampler():
        while True:
            yield env.timeout(30.0)
            q_samples.append(float(sum(len(q) for q in floor_queues)))

    def _queued_waits(now: float):
        waits = []
        for q in floor_queues:
            for p in q:
                waits.append(now - p.arrival_time)
        return waits

    # Animation frame recorder
    def recorder():
        while True:
            yield env.timeout(FRAME_INTERVAL)
            if on_frame is None:
                continue
            done  = [p for p in records if p.exit_time > 0]
            waits = [p.wait for p in done]
            queued_waits = _queued_waits(env.now)
            all_waits = waits + queued_waits
            elapsed = max(env.now, 1.0)
            on_frame({
                "t":  round(env.now / 3600.0, 4),                # hours
                "ef": [e.floor      for e in all_elevators],      # floor positions
                "ed": [e.direction   for e in all_elevators],     # directions
                "el": [len(e.riders) for e in all_elevators],     # loads
                "ql": [len(q)        for q in floor_queues],      # queues per floor
                # live running KPIs
                "aw": round(float(np.mean(all_waits)), 1)       if all_waits else 0.0,
                "aq": round(float(np.mean(q_samples)), 2)       if q_samples else 0.0,
                "ut": round(float(np.mean([
                    min(e.busy_time / elapsed * 100, 100)
                    for e in all_elevators])), 1),
            })

    env.process(arrivals())
    env.process(sampler())
    env.process(recorder())
    env.run(until=SIM_DURATION)

    done  = [p for p in records if p.exit_time > 0]
    waits = [p.wait for p in done]
    queued_waits = _queued_waits(SIM_DURATION)
    all_waits = waits + queued_waits
    utils = [min(e.busy_time / SIM_DURATION * 100, 100) for e in all_elevators]

    return {
        "avg_wait":          float(np.mean(all_waits)) if all_waits else 0.0,
        "max_wait":          float(np.max(all_waits))  if all_waits else 0.0,
        "avg_queue":         float(np.mean(q_samples)) if q_samples else 0.0,
        "utilization":       float(np.mean(utils)),
        "passengers_served": len(done),
    }


# ── Public API ─────────────────────────────────────────────────────────────

def run_both(floors, capacity, arrival_per_min):
    floors   = max(5,   min(30,    int(floors)))
    capacity = max(4,   min(20,    int(capacity)))
    arrival  = max(5.0, min(50.0,  float(arrival_per_min)))
    rate     = max(0.001, float(arrival)) / 60.0

    metrics = ["avg_wait", "max_wait", "avg_queue", "utilization", "passengers_served"]

    def _mean_ci(rows):
        out_mean = {}
        out_ci = {}
        for k in metrics:
            vals = np.array([r[k] for r in rows], dtype=float)
            m = float(np.mean(vals))
            out_mean[k] = m
            if len(vals) > 1:
                sem = float(sp_stats.sem(vals))
                if sem > 0:
                    lo, hi = sp_stats.t.interval(0.95, len(vals) - 1, loc=m, scale=sem)
                else:
                    lo = hi = m
            else:
                lo = hi = m
            out_ci[k] = [float(lo), float(hi)]
        return out_mean, out_ci

    # Run Scenario A (1 elevator): capture frames from replication 0 only
    a_rows = []
    a_frames = []
    for rep in range(NUM_REPS):
        on_frame = a_frames.append if rep == 0 else None
        a_rows.append(_one_rep(
            floors, capacity, rate, 1,
            seed=BASE_SEED + rep, on_frame=on_frame
        ))
    r_a, ci_a = _mean_ci(a_rows)

    # Run Scenario B (2 elevators): capture frames from replication 0 only
    b_rows = []
    b_frames = []
    for rep in range(NUM_REPS):
        on_frame = b_frames.append if rep == 0 else None
        b_rows.append(_one_rep(
            floors, capacity, rate, 2,
            seed=BASE_SEED + rep, on_frame=on_frame
        ))
    r_b, ci_b = _mean_ci(b_rows)

    return {
        "scenario_a": {
            "kpis": r_a,
            "ci": ci_a,
            "frames": a_frames,
        },
        "scenario_b": {
            "kpis": r_b,
            "ci": ci_b,
            "frames": b_frames,
        },
        "params": {
            "floors": floors, "capacity": capacity, "arrival": arrival,
            "duration_hr": SIM_DURATION // 3600,
        },
    }
