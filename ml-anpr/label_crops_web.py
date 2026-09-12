"""Local web-based labeling tool for the fine-tuning dataset (Step 2).
Replaces label_crops.py -- macOS's built-in Tk has real rendering bugs on
modern macOS (blank windows), so this uses a tiny local web server and
your normal browser instead, which doesn't have that problem.

Run with: python label_crops_web.py
Then open the printed http://localhost:8765 link (it also tries to open
automatically). Same behavior as before: type the plate, press Enter to
save + next; leave blank + Enter to skip (no plate visible); type just ?
+ Enter if there's a plate but you're not sure of the exact text.
Progress saves continuously to labels.csv -- safe to stop and resume.
"""
import csv
import json
import mimetypes
import os
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CROPS_DIR = os.path.expanduser("~/Desktop/training_crops_selected")
LABELS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "labels.csv")
PORT = 8765


def find_all_crops():
    paths = []
    for root, _, files in os.walk(CROPS_DIR):
        for f in sorted(files):
            if f.lower().endswith((".png", ".jpg", ".jpeg")):
                paths.append(os.path.join(root, f))
    return paths


def load_existing_labels():
    done = {}
    if os.path.exists(LABELS_PATH):
        with open(LABELS_PATH, newline="") as f:
            for row in csv.reader(f):
                if len(row) == 2:
                    done[row[0]] = row[1]
    return done


ALL_CROPS = find_all_crops()
DONE = load_existing_labels()
REMAINING = [p for p in ALL_CROPS if p not in DONE]

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Plate Labeling</title>
<style>
  body {{ font-family: -apple-system, sans-serif; text-align: center; background: #1e1e1e; color: #eee; padding-top: 40px; }}
  #progress {{ font-size: 18px; margin-bottom: 10px; }}
  #crop {{ max-width: 700px; border: 2px solid #555; margin-bottom: 20px; image-rendering: pixelated; }}
  input {{ font-size: 28px; text-align: center; width: 320px; padding: 8px; border-radius: 6px; border: none; }}
  #hint {{ color: #999; font-size: 13px; margin-top: 20px; line-height: 1.6; }}
</style></head>
<body>
  <div id="progress">{progress}</div>
  <div><img id="crop" src="/image?t={cachebust}"></div>
  <input id="label" autofocus autocomplete="off">
  <div id="hint">
    Type the plate text, press Enter to save + next.<br>
    Leave blank and press Enter to skip (no plate visible).<br>
    Type just ? and press Enter if there's a plate but you're not sure of the exact text
    (don't guess -- a wrong label is worse than no label).
  </div>
<script>
  const input = document.getElementById('label');
  input.addEventListener('keydown', async (e) => {{
    if (e.key !== 'Enter') return;
    const label = input.value.trim().toUpperCase();
    const resp = await fetch('/save', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{label}})
    }});
    const data = await resp.json();
    if (data.done) {{
      document.body.innerHTML = '<h1>All done! ' + data.total_labeled + '/' + data.total + ' labeled.</h1>';
    }} else {{
      document.getElementById('progress').textContent = data.progress;
      document.getElementById('crop').src = '/image?t=' + Date.now();
      input.value = '';
    }}
  }});
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            total = len(ALL_CROPS)
            done_count = len(DONE)
            if not REMAINING:
                body = f"<h1>All done! {done_count}/{total} labeled.</h1>".encode()
            else:
                progress = f"{done_count + 1} / {total}   ({os.path.basename(REMAINING[0])})"
                body = PAGE.format(progress=progress, cachebust=done_count).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/image"):
            if not REMAINING:
                self.send_response(404)
                self.end_headers()
                return
            path = REMAINING[0]
            mime = mimetypes.guess_type(path)[0] or "image/png"
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/save" or not REMAINING:
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        label = (body.get("label") or "").strip().upper()

        path = REMAINING.pop(0)
        DONE[path] = label if label else "SKIP"
        with open(LABELS_PATH, "a", newline="") as f:
            csv.writer(f).writerow([path, DONE[path]])

        total = len(ALL_CROPS)
        done_count = len(DONE)
        if REMAINING:
            resp = {
                "done": False,
                "progress": f"{done_count + 1} / {total}   ({os.path.basename(REMAINING[0])})",
            }
        else:
            resp = {"done": True, "total_labeled": done_count, "total": total}

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())


if __name__ == "__main__":
    print(f"Found {len(ALL_CROPS)} crops, {len(DONE)} already labeled, {len(REMAINING)} remaining.")
    url = f"http://localhost:{PORT}/"
    print(f"Opening {url} ...")
    webbrowser.open(url)
    HTTPServer(("localhost", PORT), Handler).serve_forever()
