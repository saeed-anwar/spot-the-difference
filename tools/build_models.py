#!/usr/bin/env python3
"""
Build data/models.js from the model prediction files in tools/predictions/.

Every model's boxes are converted to the real image pixels ([x, y, width, height]
on the 128x128 pictures) so the website can score them exactly like a player.

Usage (from the repository root):
    python tools/build_models.py

To add a model, put its prediction files in tools/predictions/ and add an entry
to MODELS below.
"""
import glob
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRED_DIR = ROOT / "tools" / "predictions"
ANNOTATIONS = ROOT / "tools" / "annotations.json"
OUT = ROOT / "data" / "models.js"

# frame:
#   "declared" = boxes are in the width/height that the prediction file declares for each image
#   "grid1000" = boxes are on a 0-1000 grid across the image (ignores the declared size)
MODELS = [
    {"name": "ChatGPT 5.5 Medium", "short": "ChatGPT", "files": "ChatGPT*.json", "frame": "declared"},
    {"name": "Gemini 3.5 Flash", "short": "Gemini", "files": "Gemini*.json", "frame": "declared"},
    {"name": "Gemma", "short": "Gemma", "files": "gemma_*.json", "frame": "grid1000"},
]

# A model marks a changed icon in both picture A and picture B. Those two boxes are merged
# into one box (their union), the way a player draws a single box on the spot, when they
# have the same icon_id and overlap by at least MERGE_MIN_IOU. Boxes the model labels as a
# move ("translation") stay separate (old spot and new spot), unless they are practically
# the same box (IoU >= SAME_BOX_IOU).
MERGE_MIN_IOU = 0.1
SAME_BOX_IOU = 0.7


def iou(a, b):
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def union_box(a, b):
    x1, y1 = min(a[0], b[0]), min(a[1], b[1])
    x2, y2 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return [x1, y1, x2 - x1, y2 - y1]


def real_sizes():
    sizes = {}
    if ANNOTATIONS.exists():
        data = json.loads(ANNOTATIONS.read_text(encoding="utf-8"))
        for img in data["images"]:
            m = re.match(r"(pair_\d+)_[ab]", img["file_name"], re.I)
            if m:
                sizes[m.group(1).lower()] = (img["width"], img["height"])
    return sizes


def load_file(path, frame, sizes, log):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    file_pair = re.search(r"pair_(\d+)", Path(path).name)

    images = {}
    for img in data.get("images", []):
        role = str(img.get("pair_role", "")).lower()
        m = re.match(r"(pair_\d+)_([ab])", img.get("file_name", ""), re.I)
        if m:
            stem, role = m.group(1).lower(), m.group(2).lower()
        elif file_pair:
            stem = f"pair_{file_pair.group(1)}"
        else:
            continue
        images[img["id"]] = {"stem": stem, "role": role, "w": img.get("width"), "h": img.get("height")}

    anns = data.get("annotations", [])

    # Work out the box format for this file: x,y,w,h unless boxes only make sense as x1,y1,x2,y2.
    def frame_size(img):
        return (1000, 1000) if frame == "grid1000" else (img["w"], img["h"])

    overflow = False
    xyxy_valid = True
    for a in anns:
        img = images.get(a["image_id"])
        if not img:
            continue
        fw, fh = frame_size(img)
        x, y, w, h = a["bbox"]
        if x + w > fw * 1.02 or y + h > fh * 1.02:
            overflow = True
        if not (w > x and h > y):
            xyxy_valid = False
    fmt = "xyxy" if overflow and xyxy_valid else "xywh"
    log.append(f"  {Path(path).name}: frame={frame}, format={fmt}")

    per_pair = defaultdict(list)
    covered = set(img["stem"] for img in images.values())
    for a in anns:
        img = images.get(a["image_id"])
        if not img:
            continue
        fw, fh = frame_size(img)
        rw, rh = sizes.get(img["stem"], (128, 128))
        sx, sy = rw / fw, rh / fh
        x, y, w, h = a["bbox"]
        if fmt == "xyxy":
            w, h = w - x, h - y
        box = [x * sx, y * sy, w * sx, h * sy]
        per_pair[img["stem"]].append({
            "role": img["role"],
            "icon": a.get("icon_id"),
            "moved": str(a.get("change_type", "")).startswith("translation"),
            "box": box,
        })
    return covered, per_pair


def merge(entries):
    a_side = [e for e in entries if e["role"] == "a"]
    b_side = [e for e in entries if e["role"] != "a"]
    used_b = set()
    out = []
    for ea in a_side:
        best, best_j = 0.0, -1
        for j, eb in enumerate(b_side):
            if j in used_b:
                continue
            same_icon = ea["icon"] is not None and ea["icon"] == eb["icon"]
            moved = ea["moved"] or eb["moved"]
            v = iou(ea["box"], eb["box"])
            if same_icon:
                ok = v >= SAME_BOX_IOU or (not moved and v >= MERGE_MIN_IOU)
            else:
                ok = ea["icon"] is None and v >= 0.5
            if ok:
                if v > best:
                    best, best_j = v, j
        if best_j >= 0:
            used_b.add(best_j)
            out.append(union_box(ea["box"], b_side[best_j]["box"]))
        else:
            out.append(ea["box"])
    out += [eb["box"] for j, eb in enumerate(b_side) if j not in used_b]
    return [[round(v, 1) for v in b] for b in out]


def main():
    sizes = real_sizes()
    result = []
    log = []
    for model in MODELS:
        files = sorted(glob.glob(str(PRED_DIR / model["files"])))
        log.append(f"{model['name']}: {len(files)} file(s)")
        covered, pairs = set(), defaultdict(list)
        for f in files:
            c, p = load_file(f, model["frame"], sizes, log)
            covered |= c
            for stem, entries in p.items():
                pairs[stem].extend(entries)
        result.append({
            "name": model["name"],
            "short": model["short"],
            "pairs": {stem: merge(pairs.get(stem, [])) for stem in sorted(covered)},
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for m in result:
        pairs = ",\n".join(f'    "{k}": {json.dumps(v)}' for k, v in m["pairs"].items())
        lines.append(f'  {{"name": {json.dumps(m["name"])}, "short": {json.dumps(m["short"])}, "pairs": {{\n{pairs}\n  }}}}')
    OUT.write_text(
        "// Generated by tools/build_models.py. Do not edit by hand; re-run the script instead.\n"
        "// Boxes are [x, y, width, height] in real image pixels.\n"
        "window.MODELS = [\n" + ",\n".join(lines) + "\n];\n",
        encoding="utf-8",
    )
    print("\n".join(log))
    print(f"Wrote {len(result)} models to {OUT}")


if __name__ == "__main__":
    main()
