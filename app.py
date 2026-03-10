"""
app.py  —  Flask server
=======================
GET  /     → index.html
POST /run  → run simulation, return JSON

The "live animation" happens entirely in the browser.
SimPy finishes in ~5-20 seconds, returns ~2880 frames per scenario,
JS plays them back at the user's chosen speed.
"""

from flask import Flask, render_template, request, jsonify
from simulation import run_both

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/run", methods=["POST"])
def run():
    body = request.get_json(force=True, silent=True) or {}
    try:
        floors   = int(float(body.get("floors",   10)))
        capacity = int(float(body.get("capacity",  8)))
        arrival  = float(body.get("arrival",  50.0))
    except (ValueError, TypeError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        return jsonify(run_both(floors, capacity, arrival))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("\n  Elevator Simulation →  http://localhost:5000\n")
    app.run(debug=True, port=5000)
