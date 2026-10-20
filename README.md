# Spot the difference

A static website where people box the differences between two nearly identical pictures. Each answer is scored against the ground truth (IoU and accuracy), then the next pair is shown. At the end, players see a summary and can download their results as JSON or CSV.

No server or build step is needed. It runs on GitHub Pages, or by opening `index.html` directly.

## Files

```
index.html            the page
styles.css            styling (light and dark mode)
app.js                drawing, scoring, progress, results, downloads
data/pairs.js         ground truth for the pairs in images/ (generated)
images/               pair_XXXX_a.png and pair_XXXX_b.png
tools/build_pairs.py  regenerates data/pairs.js from annotations.json
tools/annotations.json  your full COCO-style annotation file
```

## Put it on GitHub Pages

1. Create a new repository on GitHub and upload everything in this folder (keep the folder structure).
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
4. After a minute the site is live at `https://<your-username>.github.io/<repository-name>/`.

## Add more image pairs

`annotations.json` describes 357 pairs, but only the pairs whose images are in `images/` are used (11 right now). To add more:

1. Copy the extra `pair_XXXX_a.png` / `pair_XXXX_b.png` files into `images/`.
2. Run, from the repository root:

   ```
   python tools/build_pairs.py
   ```

3. Commit the new images and the updated `data/pairs.js`.

## Settings

At the top of `app.js`:

- `iouThreshold` (default `0.3`): the IoU a box needs to count as finding a difference. The ground-truth boxes are 24×24 cells with padding around each icon, so a box drawn tightly around the visible icon only reaches about 0.31 to 0.80 IoU. At the common 0.5 cut-off, correct but tight boxes would count as missed on several pairs (for example the "5" in pair_0007 and the U/V in pair_0009).
- `shuffle` (default `false`): set to `true` to show the pairs in a random order each session.

## Scoring

- **IoU** = overlap area ÷ combined area of a player's box and a true difference.
- Boxes and differences are matched one-to-one, highest IoU first. A difference is **found** when its matched box has IoU ≥ the threshold. Unmatched boxes are **wrong boxes**.
- **Accuracy** = found ÷ (found + missed + wrong boxes).
- **Mean IoU** = average over all true differences of the matched box's IoU (or the closest box's IoU if missed, 0 if no box touched it).
- **Precision** = found ÷ all boxes. **Recall** = found ÷ all differences.
- A moved icon (translation) is scored as two differences: its old spot and its new spot.

## Results

Progress is saved in the player's browser, so a refresh doesn't lose their place. Results are not sent anywhere: players download them from the final screen. Both formats give boxes as `[x, y, width, height]` in original image pixels, the same convention as `annotations.json`.

Because the site is fully static, the answers are in `data/pairs.js` and a determined player could look them up.
