"""
KRBL Pricing Dashboard — Scenario Library backend.

Provides GET / POST / DELETE /api/simulations so the "Save This Scenario" feature in
index.html has somewhere real to persist to, instead of failing with "Save failed —
please retry" (there was previously no server behind that URL at all).

Storage: a single JSON file (simulations.json) next to this script. That's intentionally
simple per the current requirement — swap this out for a real database later if/when the
dashboard needs to be shared beyond one machine or needs concurrent-write safety.

Run:
    pip install -r requirements.txt
    python app.py

Then open index.html as usual (as a local file, or via `python -m http.server`, etc.) —
it's pointed at http://localhost:5000/api/simulations.
"""
import json
import os
import threading
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, request

app = Flask(__name__)

# The dashboard HTML/JS is served/opened from somewhere other than localhost:5000 (a plain
# file, or a separate static file-server port), so the browser treats every request to this
# API as cross-origin. Handled here directly (no flask-cors dependency needed) by adding the
# header to every response and answering the browser's automatic OPTIONS preflight request
# for the JSON POST/DELETE calls. "*" is fine for a small internal tool run on localhost;
# tighten this to a specific origin if this ever gets deployed somewhere more exposed.
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


@app.route('/api/simulations', methods=['OPTIONS'])
@app.route('/api/simulations/<sim_id>', methods=['OPTIONS'])
def cors_preflight(sim_id=None):
    return ('', 204)

# IMPORTANT: this data file is deliberately stored OUTSIDE the folder that contains index.html
# (in ~/.krbl_dashboard/ by default), not next to app.py. If it lived alongside index.html, any
# local dev server with auto-reload/live-reload watching that folder (VS Code "Live Server",
# `live-server`, browser-sync, etc.) would see simulations.json change on every Save and force
# a full page refresh — which looks exactly like "the page reloads and logs me out immediately
# on Save", because this app keeps its logged-in state only in memory (no session cookie), so
# any real page reload wipes it. Keeping the data file out of any folder a static file-watcher
# would plausibly be pointed at avoids that class of bug entirely, regardless of which tool is
# serving index.html. Override with the KRBL_DATA_DIR environment variable if you want it
# somewhere else.
DATA_DIR = os.environ.get('KRBL_DATA_DIR') or os.path.join(os.path.expanduser('~'), '.krbl_dashboard')
os.makedirs(DATA_DIR, exist_ok=True)
DATA_FILE = os.path.join(DATA_DIR, 'simulations.json')
_lock = threading.Lock()  # guards read-modify-write of the JSON file across concurrent requests


def _read_all():
    if not os.path.exists(DATA_FILE):
        return []
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        # Corrupt or unreadable file — fail soft with an empty library rather than crashing
        # the server, so one bad write can't take the whole API down.
        return []


def _write_all(records):
    tmp_path = DATA_FILE + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, DATA_FILE)  # atomic on POSIX — avoids a half-written file on crash


@app.route('/api/simulations', methods=['GET'])
def list_simulations():
    with _lock:
        records = _read_all()
    return jsonify(records), 200


@app.route('/api/simulations', methods=['POST'])
def create_simulation():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Request body must be a JSON object.'}), 400

    record = dict(body)
    record['id'] = uuid.uuid4().hex
    # The frontend already sends its own human-readable `timestamp` (localized display
    # string), which is kept as-is. `savedAt` is added separately as a real ISO-8601
    # server-side timestamp, useful for sorting/auditing later without parsing the
    # locale-formatted string.
    record['savedAt'] = datetime.now(timezone.utc).isoformat()

    with _lock:
        records = _read_all()
        records.append(record)
        _write_all(records)

    return jsonify(record), 201


@app.route('/api/simulations/<sim_id>', methods=['DELETE'])
def delete_simulation(sim_id):
    with _lock:
        records = _read_all()
        remaining = [r for r in records if r.get('id') != sim_id]
        if len(remaining) == len(records):
            return jsonify({'error': f'No simulation found with id {sim_id}'}), 404
        _write_all(remaining)
    return jsonify({'status': 'deleted', 'id': sim_id}), 200


if __name__ == '__main__':
    print(f'Scenario data file: {DATA_FILE}')
    # debug=True's auto-reloader watches this script's own folder for .py changes and restarts
    # the server on any edit — harmless here since app.py isn't edited at runtime, but turned
    # off (use_reloader=False) to keep this server's behavior fully predictable/boring, since
    # unexpected restarts were exactly the kind of surprise behind the page-reload bug above.
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)