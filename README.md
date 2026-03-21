# Elevator Simulation

Discrete-event simulation comparing single-elevator vs dual-elevator performance over an 8-hour shift. Built with SimPy (M/D/c queueing model) and Flask, with a browser-based animated visualization.

## What It Does

Runs two scenarios side-by-side:
- **Scenario A** — 1 elevator
- **Scenario B** — 2 elevators

Both use the same random seed, arrival rate, and building parameters. The simulation generates per-frame snapshots that the frontend plays back as an animation. A results table shows final KPIs with a "BETTER" badge on the winning scenario.

## KPIs Tracked

| Metric | Description |
|---|---|
| Avg Wait (served) | Mean time passengers waited before boarding |
| Avg Wait (backlog) | Mean wait including passengers still in queue at end |
| Max Wait | Longest individual wait time |
| Avg Queue Length | Time-weighted average queue size |
| Utilization | Elevator busy time as a percentage of total sim time |
| Passengers Served | Total passengers delivered |

## Model Parameters

**Configurable (via UI sliders):**

| Parameter | Range | Default |
|---|---|---|
| Floors | 5–30 | 10 |
| Car capacity | 4–20 pax | 8 |
| Arrival rate (λ) | 5–50 pax/min | 20 |
| Animation speed | 1–120x | 20x |

**Fixed constants:**

| Constant | Value |
|---|---|
| Travel speed | 2.5 s/floor |
| Door dwell | 5.0 s/stop |
| Dispatch | SCAN with scoring (distance, direction, load, call age) |
| Queue discipline | FIFO, no reneging |
| Sim duration | 8 hours |
| Arrivals | Poisson process |
| Service time | Deterministic (travel + dwell) |

## Tech Stack

- **Backend**: Python, Flask, SimPy, NumPy, SciPy
- **Frontend**: Vanilla JS, CSS

## Setup

```bash
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Opens at `http://localhost:5000`.

## Project Structure

```
├── app.py                  # Flask server (GET /, POST /run)
├── simulation.py           # SimPy simulation engine
├── requirements.txt        # Python dependencies
├── static/
│   ├── index.js            # Frontend animation and UI logic
│   └── style.css           # Styles
├── templates/
   └── index.html          # Single-page HTML template

```

