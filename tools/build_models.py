#!/usr/bin/env python3
"""
Build data/models.js from the model prediction files in tools/predictions/<model folder>/,
or, if that folder isn't there, from tools/predictions.zip (same folders inside the zip).

Every model's boxes are converted to real image pixels ([x, y, width, height] on the
128x128 pictures) so the website can score them exactly like a player.

Usage (from the repository root):
    python tools/build_models.py

To add a model: put its prediction files in a new folder under tools/predictions/ and add
an entry to MODELS below.
"""
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRED_DIR = ROOT / "tools" / "predictions"
PRED_ZIP = ROOT / "tools" / "predictions.zip"
ANNOTATIONS = ROOT / "tools" / "annotations.json"
OUT = ROOT / "data" / "models.js"

# How each model's boxes are read.
#   frame:  "declared" = coordinates are in the width/height the file declares for each image
#           "grid1000" = coordinates are on a 0-1000 grid across the image (declared size ignored)
#   format: "xywh" = [x, y, width, height]
#           "xyxy" = [x1, y1, x2, y2]
#           "auto" = xywh, unless a file's boxes would run off the frame that way, then xyxy
# These were chosen by checking which reading puts each model's boxes on the icons in the
# pictures (see the README).
MODELS = [
    {"name": "ChatGPT 5.5 Medium", "short": "ChatGPT", "folder": "gpt-5.5-medium", "frame": "declared", "format": "xywh"},
    {"name": "Gemini 3.5 Flash", "short": "Gemini", "folder": "gemini-3.5-flash", "frame": "declared", "format": "xywh"},
    {"name": "Gemma 4 12B", "short": "Gemma", "folder": "gemma-4-12b", "frame": "grid1000", "format": "auto"},
    {"name": "GLM-4.6V Flash", "short": "GLM", "folder": "glm-4.6v-flash", "frame": "declared", "format": "auto"},
]

# Boxes a model explicitly labels as "no change" are not counted as predicted differences.
NO_CHANGE = {"none", "no_change", "nochange", "unchanged", "no change"}

# A model marks a changed icon in both picture A and picture B. Those two boxes are merged
# into one box (their union), the way a player draws a single box on the spot, when they
# have the same icon_id and overlap by at least MERGE_MIN_IOU. Boxes the model labels as a
# move ("translation") stay separate (old spot and new spot), unless they are practically
# the same box (IoU >= SAME_BOX_IOU).
MERGE_MIN_IOU = 0.1
SAME_BOX_IOU = 0.7


def num(v):
    try:
        f = float(v)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


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
    data = json.loads(ANNOTATIONS.read_text(encoding="utf-8"))
    for img in data["images"]:
        m = re.match(r"(pair_\d{4})_[ab]", img["file_name"], re.I)
        if m:
            sizes[m.group(1).lower()] = (img["width"], img["height"])
    return sizes


def role_of(img, index):
    role = str(img.get("pair_role", "")).strip().lower()
    role = {"original": "a", "modified": "b", "before": "a", "after": "b"}.get(role, role)
    if role in ("a", "b"):
        return role
    m = re.search(r"[_\-]([ab])\.\w+$", str(img.get("file_name", "")), re.I)
    if m:
        return m.group(1).lower()
    return "a" if index == 0 else "b"


def prediction_files(folder):
    """Yield (file name, text) for every .json file of one model, from the folder or the zip."""
    directory = PRED_DIR / folder
    if directory.is_dir():
        for f in sorted(directory.glob("*.json")):
            yield f.name, f.read_bytes().decode("utf-8-sig", errors="replace")
    elif PRED_ZIP.exists():
        with zipfile.ZipFile(PRED_ZIP) as z:
            for name in sorted(z.namelist()):
                parts = name.split("/")
                if name.endswith(".json") and folder in parts[:-1]:
                    yield parts[-1], z.read(name).decode("utf-8-sig", errors="replace")


def load_file(name, text, model, sizes, stats):
    try:
        data = json.loads(text)
    except ValueError as e:
        stats["unreadable files"] += 1
        print(f"  ! could not read {name}: {e}", file=sys.stderr)
        return set(), {}

    # Per-pair files (pair_0012.json) name the pair; batch files name it in each image's file_name.
    file_pair = re.fullmatch(r"pair_(\d{4})", Path(name).stem)
    images = {}
    for i, img in enumerate(data.get("images", [])):
        if file_pair:
            stem = f"pair_{file_pair.group(1)}"
        else:
            m = re.match(r"(pair_\d{4})_([ab])", str(img.get("file_name", "")), re.I)
            if not m:
                continue
            stem = m.group(1).lower()
        images[img.get("id")] = {"stem": stem, "role": role_of(img, i), "w": num(img.get("width")), "h": num(img.get("height"))}

    anns = []
    for a in data.get("annotations", []):
        img = images.get(a.get("image_id"))
        bbox = a.get("bbox")
        vals = [num(v) for v in bbox] if isinstance(bbox, list) and len(bbox) == 4 else None
        if not img or not vals or None in vals:
            stats["unusable boxes"] += 1
            continue
        if str(a.get("change_type", "")).strip().lower() in NO_CHANGE:
            stats["boxes labelled no change"] += 1
            continue
        anns.append((a, img, vals))

    def frame_size(img):
        if model["frame"] == "grid1000":
            return 1000.0, 1000.0
        return img["w"], img["h"]

    fmt = model["format"]
    if fmt == "auto":
        overflow = False
        xyxy_ok = True
        for a, img, (x, y, w, h) in anns:
            fw, fh = frame_size(img)
            if fw and fh and (x + w > fw * 1.02 or y + h > fh * 1.02):
                overflow = True
            if not (w > x and h > y):
                xyxy_ok = False
        fmt = "xyxy" if overflow and xyxy_ok else "xywh"
    stats[f"files read as {fmt}"] += 1

    covered = {img["stem"] for img in images.values()}
    per_pair = defaultdict(list)
    for a, img, (x, y, w, h) in anns:
        fw, fh = frame_size(img)
        if not fw or not fh:
            stats["unusable boxes"] += 1
            continue
        if fmt == "xyxy":
            w, h = w - x, h - y
        if w <= 0 or h <= 0:
            stats["unusable boxes"] += 1
            continue
        rw, rh = sizes.get(img["stem"], (128, 128))
        sx, sy = rw / fw, rh / fh
        per_pair[img["stem"]].append({
            "role": img["role"],
            "icon": a.get("icon_id"),
            "moved": str(a.get("change_type", "")).startswith("translation"),
            "box": [x * sx, y * sy, w * sx, h * sy],
        })
        stats["boxes used"] += 1
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
            if ok and v > best:
                best, best_j = v, j
        if best_j >= 0:
            used_b.add(best_j)
            out.append(union_box(ea["box"], b_side[best_j]["box"]))
        else:
            out.append(ea["box"])
    out += [eb["box"] for j, eb in enumerate(b_side) if j not in used_b]
    return [[round(v, 1) for v in b] for b in out]


def build(models=MODELS, quiet=False):
    sizes = real_sizes()
    result = []
    for model in models:
        stats = Counter()
        covered, pairs = set(), defaultdict(list)
        files = 0
        for name, text in prediction_files(model["folder"]):
            files += 1
            c, p = load_file(name, text, model, sizes, stats)
            covered |= c
            for stem, entries in p.items():
                pairs[stem].extend(entries)
        if not quiet:
            details = ", ".join(f"{v} {k}" for k, v in sorted(stats.items()))
            print(f"{model['name']}: {files} files, {len(covered)} pairs ({details})")
        result.append({
            "name": model["name"],
            "short": model["short"],
            "pairs": {stem: merge(pairs.get(stem, [])) for stem in sorted(covered)},
        })
    return result


def main():
    result = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    blocks = []
    for m in result:
        pairs = ",\n".join(f'    "{k}": {json.dumps(v, separators=(",", ":"))}' for k, v in m["pairs"].items())
        blocks.append(f'  {{"name": {json.dumps(m["name"])}, "short": {json.dumps(m["short"])}, "pairs": {{\n{pairs}\n  }}}}')
    OUT.write_text(
        "// Generated by tools/build_models.py. Do not edit by hand; re-run the script instead.\n"
        "// Boxes are [x, y, width, height] in real image pixels.\n"
        "window.MODELS = [\n" + ",\n".join(blocks) + "\n];\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(result)} models to {OUT}")


if __name__ == "__main__":
    main()
