import unittest

import simulation
from simulation import run_both


class SimulationInvariantTests(unittest.TestCase):
    def setUp(self):
        self._old_reps = simulation.NUM_REPS
        self._old_duration = simulation.SIM_DURATION
        self._old_interval = simulation.FRAME_INTERVAL
        simulation.NUM_REPS = 2
        simulation.SIM_DURATION = 30 * 60
        simulation.FRAME_INTERVAL = 15.0

    def tearDown(self):
        simulation.NUM_REPS = self._old_reps
        simulation.SIM_DURATION = self._old_duration
        simulation.FRAME_INTERVAL = self._old_interval

    def test_output_shape_and_basic_ranges(self):
        out = run_both(10, 8, 20)

        for scenario_key in ("scenario_a", "scenario_b"):
            s = out[scenario_key]
            self.assertIn("kpis", s)
            self.assertIn("ci", s)
            self.assertIn("frames", s)

            k = s["kpis"]
            self.assertGreaterEqual(k["avg_wait"], 0.0)
            self.assertGreaterEqual(k["avg_wait_served"], 0.0)
            self.assertGreaterEqual(k["avg_wait_backlog"], 0.0)
            self.assertGreaterEqual(k["avg_queue"], 0.0)
            self.assertGreaterEqual(k["utilization"], 0.0)
            # Allow tiny floating jitter above 100.
            self.assertLessEqual(k["utilization"], 100.01)
            self.assertGreaterEqual(k["passengers_served"], 0)

            frames = s["frames"]
            self.assertGreater(len(frames), 0)
            self.assertIn("ps", frames[0])
            self.assertIn("awb", frames[0])

    def test_passengers_served_is_monotonic_in_frames(self):
        out = run_both(10, 8, 20)
        for scenario_key in ("scenario_a", "scenario_b"):
            frames = out[scenario_key]["frames"]
            served_seq = [f["ps"] for f in frames]
            self.assertEqual(served_seq, sorted(served_seq))

    def test_two_elevators_not_worse_in_served_count_under_heavy_load(self):
        out = run_both(12, 8, 35)
        a = out["scenario_a"]["kpis"]["passengers_served"]
        b = out["scenario_b"]["kpis"]["passengers_served"]
        self.assertGreaterEqual(b, a)


if __name__ == "__main__":
    unittest.main()
