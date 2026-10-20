# Spot the difference

A static website where people box the differences between two nearly identical pictures. Each run draws 5 pairs at random. Every answer is scored against the ground truth and compared with four AI models (ChatGPT 5.5 Medium, Gemini 3.5 Flash, Gemma 4 12B and GLM-4.6V Flash). Beat every model on a pair to win its trophy.

No server or build step is needed to run it. It works on GitHub Pages, or by opening `index.html` directly.

## Files

```
index.html               the page
styles.css               styling (light and dark mode)
app.js                   drawing, scoring, random runs, trophies, results, downloads
data/pairs.js            ground truth for the pairs in images/ (generated)
data/models.js           every model's boxes for all 357 pairs, in image pixels (generated)
images/                  pair_XXXX_a.png and pair_XXXX_b.png (55 pairs: pair_0000 to pair_0054)
tools/build_pairs.py     rebuilds data/pairs.js from annotations.json and images/
tools/build_models.py    rebuilds data/models.js from the model predictions
tools/annotations.json   the full ground-truth file (357 pairs)
tools/predictions.zip    the raw prediction files, one folder per model
```

The website itself only uses `index.html`, `styles.css`, `app.js`, `data/` and `images/`. The `tools/` folder is for rebuilding the data.

## Put it on GitHub Pages

GitHub's web uploader takes at most 100 files at a time, and `images/` has 110. The easiest way is **GitHub Desktop**:

1. Install GitHub Desktop and sign in.
2. Choose **File → Clone repository** and pick your repository.
3. Copy everything from this folder into the cloned folder, replacing files when asked.
4. Back in GitHub Desktop, write a short summary (for example "55 pairs, 4 models") and click **Commit to main**, then **Push origin**.

Using the website uploader instead: upload `index.html`, `styles.css`, `app.js`, `README.md`, `data/` and `tools/` in one go, then upload the images in two batches (for example `pair_0000` to `pair_0027`, then the rest).

If your repository has the older `tools/predictions/` folder from the previous version, you can delete it; it's no longer used.

The first time, turn on Pages under **Settings → Pages**: deploy from the `main` branch, `/ (root)` folder.

## How a run works

- Each run draws `pairsPerRun` pairs (5) at random, with no repeats, and in a random order.
- The draw is balanced by difficulty: pairs are grouped by how many differences they have, and each group gets its share of the 5 slots. With the current 55 pairs (21 with 1 difference, 34 with 2), every run has 2 one-difference pairs and 3 two-difference pairs.
- Only pairs that every model has a prediction for are drawn, so trophies are always a fair fight.
- A refresh keeps the same run. **Play again** at the end draws a new one.
- The **AI model scores** page (linked from the start screen) scores the models on all 55 pairs.

## Add more pairs

The model predictions already cover all 357 pairs. To add pairs, copy their images into `images/` and run:

```
python tools/build_pairs.py
```

Commit the new images and `data/pairs.js`. Nothing else needs to change. If you add pairs with 3, 4 or 5 differences, the difficulty balance picks them up automatically.

## How the models' boxes are read

The prediction files don't all use the same coordinate system, so `tools/build_models.py` converts each model's boxes to the real 128×128 pictures. To pick each rule, the boxes were checked against where the icons actually are in the pictures (all icons, not just the changed ones), and compared with chance:

| Model | Folder | Reading |
|---|---|---|
| ChatGPT 5.5 Medium | `gpt-5.5-medium` | `[x, y, w, h]` in the size each file declares (always 128 px) |
| Gemini 3.5 Flash | `gemini-3.5-flash` | `[x, y, w, h]` in the size each file declares (varies from 100 to 200 px, scaled to 128) |
| Gemma 4 12B | `gemma-4-12b` | 0–1000 grid; `[x, y, w, h]`, or `[x1, y1, x2, y2]` in files where boxes would otherwise run off the grid |
| GLM-4.6V Flash | `glm-4.6v-flash` | the size each file declares; `[x1, y1, x2, y2]`, or `[x, y, w, h]` in files where corner coordinates are impossible |

ChatGPT and Gemini's boxes line up clearly with the icons. Gemma and GLM's files declare image sizes and file names that don't match the real pictures, and their boxes barely line up with the icons under any reading, so their scores stay very low (under 5 out of 100) whichever reading is used.

Other rules the script applies:
- Boxes a model labels as `"none"` (no change) are not counted as predicted differences.
- A model marks a changed icon once in picture A and once in picture B. When both boxes are on the same spot (same `icon_id`), they're merged into one box covering both, the way a player draws one box. Icons the model says moved keep two boxes.
- Numbers given as text are converted; boxes that can't be read are skipped and counted in the script's report.

To change a reading or add a model, edit the `MODELS` list at the top of `tools/build_models.py` (add a folder with the new model's files to `tools/predictions.zip`, or put an unzipped `tools/predictions/<folder>/` next to it), then run:

```
python tools/build_models.py
```

## Settings

At the top of `app.js`:

- `iouThreshold` (default `0.3`): the IoU a box needs to count as finding a difference. The ground-truth boxes are 24×24 cells with padding around each icon, so a box drawn tightly around the visible icon only reaches about 0.31 to 0.80 IoU; at the common 0.5 cut-off, correct but tight boxes would count as missed.
- `pairsPerRun` (default `5`): pairs per run. `0` uses every pair.
- `balanceByDifficulty` (default `true`): keep the same mix of 1-, 2-, ... difference pairs in every run.
- `trophyRule` (default `'all'`): win a trophy by beating every model on a pair. `'any'` awards it for beating at least one.
- `showModelsAfterEachPair` (default `true`): show the models' scores and boxes after each answer. Set to `false` if you're collecting human results and don't want players to see the models' answers.
- `showModelsLink` (default `true`): show the "See how the AI models scored" link on the start screen. That page lists what changed in every pair, so turn it off for a study.

## Scoring

- **IoU** = overlap area ÷ combined area of a box and a true difference.
- Boxes and differences are matched one-to-one, highest IoU first. A difference is **found** when its matched box has IoU ≥ the threshold. Unmatched boxes are **wrong boxes**.
- **Accuracy** = found ÷ (found + missed + wrong boxes).
- **Mean IoU** = average over all true differences of the matched box's IoU (or the closest box's IoU if missed).
- **Precision** = found ÷ all boxes. **Recall** = found ÷ all differences.
- **Score** = accuracy × mean IoU, out of 100, per pair. The overall score is the average of the pair scores.
- **Trophies**: you win a pair's trophy when your score is higher than every model's score on that pair (a tie doesn't count).
- A moved icon is scored as two differences: its old spot and its new spot.

## Results

Progress is saved in the player's browser. Results are not sent anywhere: players download them from the final screen. The JSON lists the pairs drawn in that run, the player's results and trophies, and the models' results on the same pairs. The CSV has one row per difference or wrong box, with a `player` column (`human` or the model name). The AI model scores page has its own CSV download. Boxes are always `[x, y, width, height]` in original image pixels, the same convention as `annotations.json`.

Because the site is fully static, the answers are in `data/pairs.js` and a determined player could look them up.
