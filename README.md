# Spot the difference

A static website where people box the differences between two nearly identical pictures. Each answer is scored against the ground truth (IoU and accuracy) and compared with how ChatGPT, Gemini and Gemma did on the same pair. At the end, players see a summary next to the models' scores and can download everything as JSON or CSV.

No server or build step is needed. It runs on GitHub Pages, or by opening `index.html` directly.

## Files

```
index.html            the page
styles.css            styling (light and dark mode)
app.js                drawing, scoring, progress, results, downloads
data/pairs.js         ground truth for the pairs in images/ (generated)
data/models.js        the AI models' boxes, converted to image pixels (generated)
images/               pair_XXXX_a.png and pair_XXXX_b.png
tools/build_pairs.py  regenerates data/pairs.js from annotations.json
tools/build_models.py regenerates data/models.js from tools/predictions/
tools/annotations.json  your full COCO-style annotation file
tools/predictions/    the ChatGPT, Gemini and Gemma prediction files
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

3. Commit the new images and the updated `data/pairs.js`. If you also add model prediction files for the new pairs, run `python tools/build_models.py` too.

## Settings

At the top of `app.js`:

- `iouThreshold` (default `0.3`): the IoU a box needs to count as finding a difference. The ground-truth boxes are 24×24 cells with padding around each icon, so a box drawn tightly around the visible icon only reaches about 0.31 to 0.80 IoU. At the common 0.5 cut-off, correct but tight boxes would count as missed on several pairs (for example the "5" in pair_0007 and the U/V in pair_0009).
- `shuffle` (default `false`): set to `true` to show the pairs in a random order each session.
- `showModelsAfterEachPair` (default `true`): show the models' scores and boxes after each answer. Set to `false` if you're collecting human results and don't want players to see the models' answers.
- `trophyRule` (default `'all'`): a player wins a pair's trophy when their score beats every AI model's score on that pair. Set to `'any'` to award it for beating at least one model.
- `showModelsLink` (default `true`): show the "See how the AI models scored" link on the start screen. That page lists what changed in every pair, so turn it off for a study.

## AI model scores

The models are scored in the browser with exactly the same rules and threshold as players. Their boxes come from `data/models.js`, which `tools/build_models.py` builds from the prediction files in `tools/predictions/`:

- **ChatGPT 5.5 Medium** and **Gemini 3.5 Flash**: boxes are read in the image size each file declares, then scaled to the real 128×128 pictures. ChatGPT and Gemini 0–4 declare 128 px; Gemini 5–9 declares 200 px and Gemini 10–14 declares 150 px.
- **Gemma**: the files declare sizes of 200–512 px and a different file name (`0001_a.png`), and many boxes run past those sizes, so they're read on a 0–1000 grid instead, which lines its boxes up with the icons. `gemma_pair_0007.json` only makes sense as `[x1, y1, x2, y2]`, so the script reads it that way (it switches automatically when `x + width` would run off the grid).
- A model marks a changed icon once in picture A and once in picture B. When both boxes are on the same spot (same `icon_id`), they're merged into one box covering both, the way a player draws one box. Boxes for an icon the model says moved are kept as two spots.

To change how a model's files are read, or to add another model, edit the `MODELS` list at the top of `tools/build_models.py` and run:

```
python tools/build_models.py
```

Then commit the updated `data/models.js`.

## Scoring

- **IoU** = overlap area ÷ combined area of a player's box and a true difference.
- Boxes and differences are matched one-to-one, highest IoU first. A difference is **found** when its matched box has IoU ≥ the threshold. Unmatched boxes are **wrong boxes**.
- **Accuracy** = found ÷ (found + missed + wrong boxes).
- **Mean IoU** = average over all true differences of the matched box's IoU (or the closest box's IoU if missed, 0 if no box touched it).
- **Precision** = found ÷ all boxes. **Recall** = found ÷ all differences.
- **Score** = accuracy × mean IoU, out of 100, for each pair. The overall score is the average of the pair scores. Each player's score (you and every model) is shown on its own card after each pair and on the final screen.
- **Trophies**: you win a pair's trophy when your score is higher than every AI model's score on that pair (a tie doesn't count). The trophy cabinet sits to the right of the pictures on desktop and above them on phones.
- A moved icon (translation) is scored as two differences: its old spot and its new spot.

## Results

Progress is saved in the player's browser, so a refresh doesn't lose their place. Results are not sent anywhere: players download them from the final screen. The JSON has the player's results plus the models' results on the same pairs; the CSV has one row per difference or wrong box, with a `player` column (`human` or the model name). The AI model scores page has its own CSV download. Boxes are always `[x, y, width, height]` in original image pixels, the same convention as `annotations.json`.

Because the site is fully static, the answers are in `data/pairs.js` and a determined player could look them up.
