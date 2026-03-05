"""
simulation.py - M/D/c Queue Elevator Simulation

Model:
  M arrivals (Poisson)
  D service times (deterministic travel + dwell)
  c parallel elevators

Key improvements:
  - Directional hall queues (up/down)
  - Time-weighted queue-length average (area under Lq(t))
  - Separate wait KPIs: served-only vs backlog-inclusive
  - Dispatch scoring uses distance, direction, load, and call age
  - Multi-rep mean + 95% CI
"""

import random
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, List, Optional

import numpy as np
import simpy
from scipy import stats as sp_stats

TRAVEL_SPEED = 2.5          # seconds per floor
DOOR_DWELL = 5.0            # seconds per stop
SIM_DURATION = 8 * 3600     # 8 hours
NUM_REPS = 1               # stronger CI stability
BASE_SEED = random.randrange(1_000_000)
FRAME_INTERVAL = 10.0

UP = 1
DOWN = -1
IDLE = 0


@dataclass
class Passenger:
    arrival_time: float
    origin: int
    dest: int
    board_time: float = 0.0
    exit_time: float = 0.0

    @property
    def direction(self) -> int:
        return UP if self.dest > self.origin else DOWN

    @property
    def wait(self) -> float:
        return self.board_time - self.arrival_time


class RepStats:
    """Replication-level counters for fast, numerically stable KPIs."""

    def __init__(self) -> None:
        self.served_count = 0
        self.wait_sum = 0.0
        self.wait_max = 0.0

        self.queue_len = 0
        self.queue_arrival_sum = 0.0

        self.queue_area = 0.0
        self._last_q_t = 0.0

    def _advance_queue_area(self, now: float) -> None:
        self.queue_area += self.queue_len * (now - self._last_q_t)
        self._last_q_t = now

    def queue_enqueue(self, now: float, arrival_time: float) -> None:
        self._advance_queue_area(now)
        self.queue_len += 1
        self.queue_arrival_sum += arrival_time

    def queue_dequeue(self, now: float, arrival_time: float) -> None:
        self._advance_queue_area(now)
        self.queue_len -= 1
        self.queue_arrival_sum -= arrival_time
        if self.queue_len < 0:
            raise RuntimeError("Queue length went negative")

    def passenger_served(self, wait: float) -> None:
        self.served_count += 1
        self.wait_sum += wait
        if wait > self.wait_max:
            self.wait_max = wait

    def avg_queue_time_weighted(self, now: float) -> float:
        if now <= 0:
            return 0.0
        area = self.queue_area + self.queue_len * (now - self._last_q_t)
        return area / now

    def backlog_wait_sum(self, now: float) -> float:
        return self.queue_len * now - self.queue_arrival_sum

    def avg_wait_served(self) -> float:
        if self.served_count == 0:
            return 0.0
        return self.wait_sum / self.served_count

    def avg_wait_backlog(self, now: float) -> float:
        denom = self.served_count + self.queue_len
        if denom == 0:
            return 0.0
        return (self.wait_sum + self.backlog_wait_sum(now)) / denom


class Elevator:
    def __init__(
        self,
        env: simpy.Environment,
        eid: int,
        floors: int,
        capacity: int,
        up_queues: List[Deque[Passenger]],
        down_queues: List[Deque[Passenger]],
        all_elevators: List["Elevator"],
        stats: RepStats,
    ):
        self.env = env
        self.eid = eid
        self.floors = floors
        self.capacity = capacity
        self.up_queues = up_queues
        self.down_queues = down_queues
        self.all_elevators = all_elevators
        self.stats = stats

        self.floor = 1
        self.direction = IDLE
        self.riders: List[Passenger] = []
        self.busy_time = 0.0

        env.process(self._run())

    def _queue_at(self, floor: int, direction: int) -> Deque[Passenger]:
        idx = floor - 1
        return self.up_queues[idx] if direction == UP else self.down_queues[idx]

    def _oldest_call_age(self, floor: int, direction: int) -> float:
        q = self._queue_at(floor, direction)
        if not q:
            return 0.0
        return self.env.now - q[0].arrival_time

    def _score_hall_call(self, floor: int, direction: int) -> float:
        dist = abs(self.floor - floor)

        if self.direction == IDLE:
            dir_penalty = 0.0
        else:
            moving_toward = (self.direction == UP and floor >= self.floor) or (
                self.direction == DOWN and floor <= self.floor
            )
            dir_penalty = 0.0 if moving_toward and self.direction == direction else 2.0

        load_penalty = (len(self.riders) / max(self.capacity, 1)) * 2.0
        age_bonus = min(self._oldest_call_age(floor, direction) / 30.0, 3.0)

        return dist + dir_penalty + load_penalty - age_bonus

    def _assigned_hall_calls(self) -> List[tuple[int, int]]:
        calls: List[tuple[int, int]] = []
        for floor in range(1, self.floors + 1):
            for direction in (UP, DOWN):
                if not self._queue_at(floor, direction):
                    continue
                my_score = self._score_hall_call(floor, direction)
                best = True
                for other in self.all_elevators:
                    if other is self:
                        continue
                    other_score = other._score_hall_call(floor, direction)
                    if other_score < my_score - 1e-9:
                        best = False
                        break
                    if abs(other_score - my_score) <= 1e-9 and other.eid < self.eid:
                        best = False
                        break
                if best:
                    calls.append((floor, direction))
        return calls

    def _candidate_targets(self) -> List[tuple[int, float]]:
        targets: List[tuple[int, float]] = []

        # Rider destinations get strong priority to prevent onboard starvation.
        for dest in {r.dest for r in self.riders}:
            score = abs(dest - self.floor) - 5.0
            targets.append((dest, score))

        # Assigned hall calls.
        for floor, direction in self._assigned_hall_calls():
            if floor == self.floor and not self._can_service_hall_here(direction):
                continue
            targets.append((floor, self._score_hall_call(floor, direction)))

        return targets

    def _can_service_hall_here(self, direction: int) -> bool:
        if len(self.riders) >= self.capacity:
            return False
        if self.riders and self.direction != IDLE and self.direction != direction:
            return False
        return True

    def _next_target(self) -> Optional[int]:
        cands = self._candidate_targets()
        if not cands:
            return None

        # Keep directional stability when scores are close.
        if self.direction != IDLE:
            biased = []
            for floor, score in cands:
                forward = (self.direction == UP and floor >= self.floor) or (
                    self.direction == DOWN and floor <= self.floor
                )
                bias = -0.5 if forward else 0.0
                biased.append((floor, score + bias))
            cands = biased

        cands.sort(key=lambda x: (x[1], abs(x[0] - self.floor), x[0]))
        return cands[0][0]

    def _travel(self, target: int):
        dist = abs(target - self.floor)
        if dist == 0:
            # Prevent zero-time spin when selected target is current floor.
            yield self.env.timeout(1.0)
            return

        t0 = self.env.now
        self.direction = UP if target > self.floor else DOWN
        yield self.env.timeout(dist * TRAVEL_SPEED)
        self.busy_time += self.env.now - t0
        self.floor = target

    def _drop_off(self) -> int:
        leaving = [r for r in self.riders if r.dest == self.floor]
        for p in leaving:
            self.riders.remove(p)
            p.exit_time = self.env.now
            self.stats.passenger_served(p.wait)
        return len(leaving)

    def _choose_board_direction(self) -> int:
        idx = self.floor - 1
        up_q = self.up_queues[idx]
        dn_q = self.down_queues[idx]

        if self.riders:
            return self.direction

        if not up_q and not dn_q:
            return IDLE
        if up_q and not dn_q:
            return UP
        if dn_q and not up_q:
            return DOWN

        # Both queues present: serve older call first.
        up_age = self.env.now - up_q[0].arrival_time
        dn_age = self.env.now - dn_q[0].arrival_time
        return UP if up_age >= dn_age else DOWN

    def _board(self) -> int:
        board_dir = self._choose_board_direction()
        if board_dir == IDLE:
            return 0

        q = self._queue_at(self.floor, board_dir)
        boarded = 0
        while q and len(self.riders) < self.capacity:
            p = q.popleft()
            self.stats.queue_dequeue(self.env.now, p.arrival_time)
            p.board_time = self.env.now
            self.riders.append(p)
            boarded += 1

        # Direction follows boarded flow when empty beforehand.
        if boarded > 0:
            self.direction = board_dir

        return boarded

    def _service_current_floor(self):
        dropped = self._drop_off()
        boarded = self._board()
        if dropped or boarded:
            t0 = self.env.now
            yield self.env.timeout(DOOR_DWELL)
            self.busy_time += self.env.now - t0

    def _run(self):
        while True:
            yield from self._service_current_floor()

            target = self._next_target()
            if target is None:
                self.direction = IDLE
                yield self.env.timeout(1.0)
                continue

            yield from self._travel(target)


def _one_rep(
    floors: int,
    capacity: int,
    rate_per_sec: float,
    num_elevators: int,
    seed: int,
    on_frame: Optional[Callable] = None,
):
    rng = random.Random(seed)
    env = simpy.Environment()
    stats = RepStats()

    up_queues = [deque() for _ in range(floors)]
    down_queues = [deque() for _ in range(floors)]

    all_elevators: List[Elevator] = []
    for i in range(num_elevators):
        e = Elevator(
            env,
            i,
            floors,
            capacity,
            up_queues,
            down_queues,
            all_elevators,
            stats,
        )
        all_elevators.append(e)

    def enqueue_passenger(p: Passenger) -> None:
        idx = p.origin - 1
        if p.direction == UP:
            up_queues[idx].append(p)
        else:
            down_queues[idx].append(p)
        stats.queue_enqueue(env.now, p.arrival_time)

    def arrivals():
        while True:
            yield env.timeout(rng.expovariate(rate_per_sec))
            origin = rng.randint(1, floors)
            dest = rng.randint(1, floors)
            while dest == origin:
                dest = rng.randint(1, floors)
            enqueue_passenger(Passenger(env.now, origin, dest))

    def recorder():
        while True:
            yield env.timeout(FRAME_INTERVAL)
            if on_frame is None:
                continue

            now = env.now
            util_vals = [e.busy_time / now * 100.0 if now > 0 else 0.0 for e in all_elevators]
            avg_util = float(np.mean(util_vals)) if util_vals else 0.0

            ql = [len(up_queues[i]) + len(down_queues[i]) for i in range(floors)]

            on_frame(
                {
                    "t": round(now / 3600.0, 4),
                    "ef": [e.floor for e in all_elevators],
                    "ed": [e.direction for e in all_elevators],
                    "el": [len(e.riders) for e in all_elevators],
                    "ql": ql,
                    # UI compatibility
                    "aw": round(stats.avg_wait_served(), 1),
                    "aq": round(stats.avg_queue_time_weighted(now), 2),
                    "ut": round(avg_util, 1),
                    "ps": int(stats.served_count),
                    # Extended live metrics
                    "awb": round(stats.avg_wait_backlog(now), 1),
                }
            )

    env.process(arrivals())
    env.process(recorder())
    env.run(until=SIM_DURATION)

    util_vals = [e.busy_time / SIM_DURATION * 100.0 for e in all_elevators]
    avg_util = float(np.mean(util_vals)) if util_vals else 0.0

    # Keep unclipped utilization; tests should detect if model exceeds 100 materially.
    return {
        "avg_wait": round(stats.avg_wait_served(), 2),
        "avg_wait_served": round(stats.avg_wait_served(), 2),
        "avg_wait_backlog": round(stats.avg_wait_backlog(SIM_DURATION), 2),
        "max_wait": round(stats.wait_max, 2),
        "max_wait_served": round(stats.wait_max, 2),
        "avg_queue": round(stats.avg_queue_time_weighted(SIM_DURATION), 2),
        "utilization": round(avg_util, 2),
        "passengers_served": int(stats.served_count),
    }


def _mean_ci(rows: List[dict], metrics: List[str]):
    out_mean = {}
    out_ci = {}

    for k in metrics:
        vals = np.array([r[k] for r in rows], dtype=float)
        m = float(np.mean(vals))

        if k == "passengers_served":
            out_mean[k] = int(round(m))
        else:
            out_mean[k] = round(m, 2)

        if len(vals) > 1:
            sem = float(sp_stats.sem(vals))
            if sem > 0:
                lo, hi = sp_stats.t.interval(0.95, len(vals) - 1, loc=m, scale=sem)
            else:
                lo = hi = m
        else:
            lo = hi = m

        out_ci[k] = [round(float(lo), 3), round(float(hi), 3)]

    return out_mean, out_ci


def _run_scenario(floors: int, capacity: int, rate: float, num_elevators: int, seed: int):
    rows = []
    frames = []

    for rep in range(NUM_REPS):
        on_frame = frames.append if rep == 0 else None

        rows.append(
            _one_rep(
                floors=floors,
                capacity=capacity,
                rate_per_sec=rate,
                num_elevators=num_elevators,
                seed=seed, 
                on_frame=on_frame,
            )
        )

    metrics = [
        "avg_wait",
        "avg_wait_served",
        "avg_wait_backlog",
        "max_wait",
        "max_wait_served",
        "avg_queue",
        "utilization",
        "passengers_served",
    ]

    kpis, ci = _mean_ci(rows, metrics)
    return {"kpis": kpis, "ci": ci, "frames": frames}


def run_both(floors, capacity, arrival_per_min):
    floors = max(5, min(30, int(floors)))
    capacity = max(4, min(20, int(capacity)))
    arrival = max(5.0, min(50.0, float(arrival_per_min)))
    rate = max(0.001, arrival) / 60.0

    #  One random seed per full experiment run
    base_seed = random.randrange(1_000_000)

    scenario_a = _run_scenario(floors, capacity, rate, 1, base_seed)
    scenario_b = _run_scenario(floors, capacity, rate, 2, base_seed)

    return {
        "scenario_a": scenario_a,
        "scenario_b": scenario_b,
        "params": {
            "floors": floors,
            "capacity": capacity,
            "arrival": arrival,
            "duration_hr": SIM_DURATION // 3600,
            "reps": NUM_REPS,
        },
    }
