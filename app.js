(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Settings you may want to change
  // ---------------------------------------------------------------------------
  const CONFIG = {
    // A box must reach this IoU with a true difference to count as found.
    // The ground-truth boxes are 24x24 cells with padding around each icon, so a box drawn
    // tightly around the visible icon scores roughly 0.31-0.80. At 0.5, correct tight boxes
    // would be marked as missed on several pairs; 0.3 accepts them.
    iouThreshold: 0.3,
    shuffle: false,      // true = show pairs in a random order for each session
    minBoxSize: 2,       // boxes narrower or shorter than this (in picture pixels) are ignored
    storageKey: 'spot-the-difference:session:v1',
  };

  const PAIRS = Array.isArray(window.PAIRS) ? window.PAIRS : [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const round1 = (v) => Math.round(v * 10) / 10;
  const pct = (v) => (v == null || Number.isNaN(v) ? '–' : `${Math.round(v * 100)}%`);
  const dec = (v) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(2));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function iou(a, b) {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;
    const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
    const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
    const inter = ix * iy;
    const union = aw * ah + bw * bh - inter;
    return union > 0 ? inter / union : 0;
  }

  function prettyName(raw) {
    if (!raw) return 'icon';
    const parts = String(raw).split('_');
    if (parts[0] === 'LETTER' && parts[1]) return `letter ${parts[1].toUpperCase()}`;
    return parts.map((p) => p.toLowerCase()).join(' ');
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function describe(diff) {
    const before = prettyName(diff.before);
    const after = prettyName(diff.after);
    const type = String(diff.type || '').replace(/_fallback$/, '');
    switch (type) {
      case 'removal': return `${cap(before)} removed`;
      case 'addition': return `${cap(after)} added`;
      case 'substitution':
      case 'substitution_same_type': return `${cap(before)} changed to ${after}`;
      case 'substitution_filled': return `${cap(before)} fill changed`;
      case 'rotation': return `${cap(before)} rotated`;
      case 'translation': return `${cap(before)} moved`;
      default: return 'Something changed';
    }
  }

  // Turn the ground-truth differences of a pair into the spots a player should box.
  // A moved icon gives two spots (where it was, and where it went).
  function spotsFor(pair) {
    const spots = [];
    pair.differences.forEach((d) => {
      const label = describe(d);
      const boxes = [d.bbox_before, d.bbox_after].filter(Boolean);
      if (boxes.length === 2 && iou(boxes[0], boxes[1]) < 0.5) {
        spots.push({ label: `${label} (old spot)`, type: d.type, bbox: boxes[0] });
        spots.push({ label: `${label} (new spot)`, type: d.type, bbox: boxes[1] });
      } else if (boxes.length) {
        spots.push({ label, type: d.type, bbox: boxes[0] });
      }
    });
    return spots;
  }

  // Greedy one-to-one matching on IoU, highest first (the usual detection-benchmark rule).
  function scorePair(marks, spots, threshold) {
    const candidates = [];
    marks.forEach((m, mi) => spots.forEach((s, si) => {
      const v = iou(m, s.bbox);
      if (v >= threshold) candidates.push([v, mi, si]);
    }));
    candidates.sort((a, b) => b[0] - a[0]);
    const markTo = new Array(marks.length).fill(-1);
    const spotTo = new Array(spots.length).fill(-1);
    for (const [, mi, si] of candidates) {
      if (markTo[mi] < 0 && spotTo[si] < 0) { markTo[mi] = si; spotTo[si] = mi; }
    }

    const spotResults = spots.map((s, si) => {
      const mi = spotTo[si];
      if (mi >= 0) {
        return { label: s.label, type: s.type, bbox: s.bbox, found: true, iou: iou(marks[mi], s.bbox), box: mi };
      }
      let best = 0; let bestIdx = -1;
      marks.forEach((m, i) => { const v = iou(m, s.bbox); if (v > best) { best = v; bestIdx = i; } });
      return { label: s.label, type: s.type, bbox: s.bbox, found: false, iou: best, box: bestIdx };
    });

    const wrong = [];
    markTo.forEach((si, mi) => { if (si < 0) wrong.push(mi); });

    const tp = spotResults.filter((s) => s.found).length;
    const fn = spots.length - tp;
    const fp = wrong.length;
    const denom = tp + fn + fp;
    const accuracy = denom ? tp / denom : 1;
    const meanIou = spotResults.length ? spotResults.reduce((a, s) => a + s.iou, 0) / spotResults.length : 0;
    const status = fn === 0 && fp === 0 ? 'solved' : tp === 0 ? 'missed' : 'partial';
    return { spots: spotResults, wrong, tp, fn, fp, accuracy, meanIou, status };
  }

  // ---------------------------------------------------------------------------
  // State (saved in this browser so a refresh doesn't lose progress)
  // ---------------------------------------------------------------------------
  const pairIds = PAIRS.map((p) => p.id);
  let state = null;

  function freshState(participant) {
    const order = PAIRS.map((_, i) => i);
    if (CONFIG.shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    return {
      participant: participant || '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pairIds,
      order,
      pos: 0,
      results: [],
      marks: [],
      checked: false,
      pairStart: Date.now(),
    };
  }

  function save() {
    try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) return null;
      const s = JSON.parse(raw);
      const sameData = Array.isArray(s.pairIds) && s.pairIds.length === pairIds.length && s.pairIds.every((id, i) => id === pairIds[i]);
      if (!sameData || !Array.isArray(s.order) || !Array.isArray(s.marks)) return null;
      return s;
    } catch (e) { return null; }
  }
  function clearSaved() {
    try { localStorage.removeItem(CONFIG.storageKey); } catch (e) { /* ignore */ }
  }

  const currentPair = () => PAIRS[state.order[state.pos]];

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  const screens = { start: $('screen-start'), play: $('screen-play'), done: $('screen-done') };
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
    window.scrollTo(0, 0);
  }

  function initStart() {
    document.querySelectorAll('.threshold').forEach((el) => { el.textContent = CONFIG.iouThreshold.toFixed(2); });
    if (!PAIRS.length) {
      $('no-data').hidden = false;
      $('start-form').hidden = true;
      return;
    }
    $('start-count').textContent = `There are ${PAIRS.length} pairs. It takes a few minutes.`;
    const saved = loadSaved();
    if (saved && !saved.finishedAt && (saved.pos > 0 || saved.marks.length || saved.checked)) {
      $('resume').hidden = false;
      $('resume-detail').textContent = `on pair ${Math.min(saved.pos + 1, PAIRS.length)} of ${PAIRS.length}`;
      $('participant').value = saved.participant || '';
    }
  }

  $('start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state = freshState($('participant').value.trim());
    save();
    startPlay();
  });
  $('btn-resume').addEventListener('click', () => {
    state = loadSaved();
    if (!state) { $('resume').hidden = true; return; }
    if (state.pos >= state.order.length) finish(); else startPlay();
  });
  $('btn-discard').addEventListener('click', () => {
    clearSaved();
    $('resume').hidden = true;
    $('participant').focus();
  });

  // ---------------------------------------------------------------------------
  // Play
  // ---------------------------------------------------------------------------
  const canvases = Array.from(document.querySelectorAll('.canvas'));
  const imgA = $('img-a');
  const imgB = $('img-b');
  const svgA = $('svg-a');
  const svgB = $('svg-b');
  let drag = null;

  function startPlay() {
    show('play');
    loadPair();
  }

  function loadPair() {
    const pair = currentPair();
    const w = pair.width || 128;
    const h = pair.height || 128;
    canvases.forEach((c) => { c.style.aspectRatio = `${w} / ${h}`; });
    [svgA, svgB].forEach((svg) => {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
    });
    imgA.src = pair.a;
    imgB.src = pair.b;

    // Warm the cache for the next pair.
    const next = PAIRS[state.order[state.pos + 1]];
    if (next) { new Image().src = next.a; new Image().src = next.b; }

    $('counter').textContent = `Pair ${state.pos + 1} of ${state.order.length}`;
    renderProgress();

    if (state.checked && state.results[state.pos]) {
      showFeedback(state.results[state.pos]);
    } else {
      state.checked = false;
      $('controls').hidden = false;
      $('feedback').hidden = true;
      canvases.forEach((c) => c.classList.remove('is-locked'));
    }
    updateButtons();
    drawOverlays();
  }

  function renderProgress() {
    const ol = $('progress');
    ol.innerHTML = '';
    state.order.forEach((_, i) => {
      const li = document.createElement('li');
      const r = state.results[i];
      let label = `Pair ${i + 1}: not done yet`;
      if (r) {
        li.classList.add(`is-${r.status}`);
        label = `Pair ${i + 1}: ${r.status === 'solved' ? 'solved' : r.status === 'partial' ? 'partly right' : 'missed'}`;
      }
      if (i === state.pos) { li.classList.add('is-current'); label += ' (current)'; }
      li.setAttribute('aria-label', label);
      li.title = label;
      ol.appendChild(li);
    });
  }

  function updateButtons() {
    const has = state.marks.length > 0;
    $('btn-undo').disabled = !has || state.checked;
    $('btn-clear').disabled = !has || state.checked;
  }

  // ---- Drawing ----
  function toPicture(evt, canvas) {
    const pair = currentPair();
    const rect = canvas.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * pair.width;
    const y = ((evt.clientY - rect.top) / rect.height) * pair.height;
    return { x: clamp(x, 0, pair.width), y: clamp(y, 0, pair.height) };
  }

  function dragBox(d) {
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    return [round1(x), round1(y), round1(Math.abs(d.x1 - d.x0)), round1(Math.abs(d.y1 - d.y0))];
  }

  function onPointerDown(e) {
    if (state.checked || drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);
    const p = toPicture(e, canvas);
    drag = { id: e.pointerId, canvas, x0: p.x, y0: p.y, x1: p.x, y1: p.y, cx: e.clientX, cy: e.clientY, moved: false };
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const p = toPicture(e, drag.canvas);
    drag.x1 = p.x;
    drag.y1 = p.y;
    if (Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) > 6) drag.moved = true;
    drawOverlays();
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      // A tap removes the top-most box under the finger.
      for (let i = state.marks.length - 1; i >= 0; i--) {
        const [x, y, w, h] = state.marks[i];
        if (d.x0 >= x - 1 && d.x0 <= x + w + 1 && d.y0 >= y - 1 && d.y0 <= y + h + 1) {
          state.marks.splice(i, 1);
          save();
          break;
        }
      }
    } else {
      const box = dragBox(d);
      if (box[2] >= CONFIG.minBoxSize && box[3] >= CONFIG.minBoxSize) {
        state.marks.push(box);
        save();
      }
    }
    updateButtons();
    drawOverlays();
  }

  function onPointerCancel(e) {
    if (drag && e.pointerId === drag.id) { drag = null; drawOverlays(); }
  }

  canvases.forEach((c) => {
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerCancel);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // ---- Overlays ----
  function rect(box, cls) {
    const [x, y, w, h] = box;
    return `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  }

  function tag(box, text, cls, pair, scale) {
    const size = 20 / scale;
    const font = 13 / scale;
    const [x, y, , h] = box;
    let ty = y - size - 1 / scale;
    if (ty < 0) ty = Math.min(y + h + 1 / scale, pair.height - size);
    const tx = clamp(x, 0, pair.width - size);
    return `<rect class="ov-tag-bg ${cls}" x="${tx}" y="${ty}" width="${size}" height="${size}" rx="${3 / scale}"/>` +
      `<text class="ov-tag" x="${tx + size / 2}" y="${ty + size / 2}" font-size="${font}" text-anchor="middle" dominant-baseline="central">${text}</text>`;
  }

  function drawOverlays() {
    if (!state) return;
    const pair = currentPair();
    const width = svgA.getBoundingClientRect().width || 1;
    const scale = width / pair.width;
    let html = '';

    const result = state.checked ? state.results[state.pos] : null;
    if (result) {
      const wrongSet = new Set(result.wrong);
      result.spots.forEach((s) => { html += rect(s.bbox, `ov-truth ${s.found ? 'is-right' : 'is-missed'}`); });
      result.marks.forEach((m, i) => { html += rect(m, `ov-mark ${wrongSet.has(i) ? 'is-wrong' : 'is-right'}`); });
      result.spots.forEach((s, i) => { html += tag(s.bbox, String(i + 1), s.found ? 'is-right' : 'is-missed', pair, scale); });
      result.wrong.forEach((mi) => { html += tag(result.marks[mi], '×', 'is-wrong', pair, scale); });
    } else {
      state.marks.forEach((m) => { html += rect(m, 'ov-mark'); });
      if (drag && drag.moved) html += rect(dragBox(drag), 'ov-draft');
    }
    svgA.innerHTML = html;
    svgB.innerHTML = html;
  }

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (state && !screens.play.hidden) drawOverlays(); }).observe(canvases[0]);
  }

  // ---- Buttons ----
  $('btn-undo').addEventListener('click', () => {
    if (state.checked) return;
    state.marks.pop();
    save(); updateButtons(); drawOverlays();
  });
  $('btn-clear').addEventListener('click', () => {
    if (state.checked) return;
    state.marks = [];
    save(); updateButtons(); drawOverlays();
  });
  $('btn-check').addEventListener('click', check);
  $('btn-next').addEventListener('click', next);

  function check() {
    if (state.checked) return;
    const pair = currentPair();
    const marks = state.marks.map((m) => m.slice());
    const scored = scorePair(marks, spotsFor(pair), CONFIG.iouThreshold);
    const result = {
      pairId: pair.id,
      fileA: pair.a.split('/').pop(),
      fileB: pair.b.split('/').pop(),
      width: pair.width,
      height: pair.height,
      timeMs: Date.now() - (state.pairStart || Date.now()),
      marks,
      ...scored,
    };
    state.results[state.pos] = result;
    state.checked = true;
    save();
    renderProgress();
    showFeedback(result);
    drawOverlays();
  }

  function showFeedback(result) {
    canvases.forEach((c) => c.classList.add('is-locked'));
    $('controls').hidden = true;
    const ul = $('findings');
    ul.innerHTML = '';

    result.spots.forEach((s, i) => {
      const li = document.createElement('li');
      const status = s.found ? 'is-right' : 'is-missed';
      let note;
      if (s.found) note = `IoU ${dec(s.iou)}`;
      else if (s.iou > 0) note = `Closest box: IoU ${dec(s.iou)}, needs ${CONFIG.iouThreshold.toFixed(2)}`;
      else note = 'No box on it';
      li.innerHTML = `<span class="tag ${status}">${i + 1}</span>` +
        `<span class="finding-text"></span>` +
        `<span class="finding-status ${status}">${s.found ? 'Found' : 'Missed'}<span class="finding-note"></span></span>`;
      li.querySelector('.finding-text').textContent = s.label;
      li.querySelector('.finding-note').textContent = note;
      ul.appendChild(li);
    });

    if (result.wrong.length) {
      const li = document.createElement('li');
      const n = result.wrong.length;
      li.innerHTML = `<span class="tag is-wrong">×</span>` +
        `<span class="finding-text">${n === 1 ? 'A box with no difference under it' : `${n} boxes with no difference under them`}</span>` +
        `<span class="finding-status is-wrong">${n === 1 ? 'Wrong box' : 'Wrong boxes'}</span>`;
      ul.appendChild(li);
    }

    $('pair-score').innerHTML = `Accuracy <b>${pct(result.accuracy)}</b>&emsp;Mean IoU <b>${dec(result.meanIou)}</b>`;
    $('btn-next').textContent = state.pos + 1 >= state.order.length ? 'See results' : 'Next pair';
    $('feedback').hidden = false;
    $('btn-next').focus({ preventScroll: true });
  }

  function next() {
    if (!state.checked) return;
    state.pos += 1;
    state.marks = [];
    state.checked = false;
    state.pairStart = Date.now();
    if (state.pos >= state.order.length) { finish(); return; }
    save();
    loadPair();
    window.scrollTo({ top: 0 });
  }

  document.addEventListener('keydown', (e) => {
    if (!state || screens.play.hidden) return;
    const tagName = (e.target && e.target.tagName) || '';
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('btn-undo').click();
    } else if (e.key === 'Escape' && drag) {
      drag = null; drawOverlays();
    } else if (e.key === 'Enter' && tagName !== 'BUTTON' && tagName !== 'INPUT' && tagName !== 'SUMMARY') {
      e.preventDefault();
      if (state.checked) next(); else check();
    }
  });

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------
  function summarise() {
    const rs = state.results.filter(Boolean);
    const found = rs.reduce((a, r) => a + r.tp, 0);
    const missed = rs.reduce((a, r) => a + r.fn, 0);
    const wrong = rs.reduce((a, r) => a + r.fp, 0);
    const allSpots = rs.flatMap((r) => r.spots);
    const boxes = found + wrong;
    return {
      pairs: rs.length,
      differences: found + missed,
      found,
      missed,
      wrong_boxes: wrong,
      accuracy: found + missed + wrong ? found / (found + missed + wrong) : null,
      mean_iou: allSpots.length ? allSpots.reduce((a, s) => a + s.iou, 0) / allSpots.length : null,
      precision: boxes ? found / boxes : null,
      recall: found + missed ? found / (found + missed) : null,
      pairs_solved: rs.filter((r) => r.status === 'solved').length,
    };
  }

  function finish() {
    if (!state.finishedAt) state.finishedAt = new Date().toISOString();
    state.pos = state.order.length;
    save();
    const s = summarise();

    const wrongText = s.wrong_boxes === 0 ? 'and no wrong boxes' : s.wrong_boxes === 1 ? 'with 1 wrong box' : `with ${s.wrong_boxes} wrong boxes`;
    $('done-sentence').textContent = `You found ${s.found} of ${s.differences} differences, ${wrongText}.`;

    const stats = [
      ['Accuracy', pct(s.accuracy)],
      ['Mean IoU', dec(s.mean_iou)],
      ['Precision', pct(s.precision)],
      ['Recall', pct(s.recall)],
      ['Pairs solved', `${s.pairs_solved} of ${s.pairs}`],
    ];
    $('stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const tbody = $('results-body');
    tbody.innerHTML = '';
    state.results.forEach((r) => {
      if (!r) return;
      const pair = PAIRS.find((p) => p.id === r.pairId);
      const changes = pair ? pair.differences.map(describe).join('; ') : '';
      const resultText = r.status === 'solved' ? 'Solved' : r.status === 'partial' ? 'Partly' : 'Missed';
      const cls = r.status === 'solved' ? 'is-right' : r.status === 'partial' ? 'is-partial' : 'is-missed';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td></td><td></td><td class="${cls}">${resultText}</td><td class="num">${pct(r.accuracy)}</td><td class="num">${dec(r.meanIou)}</td>`;
      tr.children[0].textContent = r.fileA.replace(/_a\.\w+$/i, '');
      tr.children[1].textContent = changes;
      tbody.appendChild(tr);
    });

    show('done');
  }

  $('btn-restart').addEventListener('click', () => {
    const participant = state ? state.participant : '';
    clearSaved();
    state = null;
    $('resume').hidden = true;
    $('participant').value = participant;
    show('start');
  });

  // ---- Downloads ----
  function exportObject() {
    return {
      participant_id: state.participant || null,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      iou_threshold: CONFIG.iouThreshold,
      box_format: '[x, y, width, height] in original image pixels',
      summary: summarise(),
      pairs: state.results.filter(Boolean).map((r) => ({
        pair_id: r.pairId,
        file_a: r.fileA,
        file_b: r.fileB,
        image_width: r.width,
        image_height: r.height,
        time_ms: r.timeMs,
        result: r.status,
        accuracy: r.accuracy,
        mean_iou: r.meanIou,
        boxes: r.marks,
        differences: r.spots.map((s) => ({
          description: s.label,
          change_type: s.type,
          bbox: s.bbox,
          found: s.found,
          iou: s.iou,
          box_index: s.box >= 0 ? s.box : null,
        })),
        wrong_box_indices: r.wrong,
      })),
    };
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const head = ['participant_id', 'pair_id', 'file_a', 'file_b', 'row_type', 'description', 'change_type',
      'truth_x', 'truth_y', 'truth_w', 'truth_h', 'box_x', 'box_y', 'box_w', 'box_h', 'iou', 'found', 'time_ms'];
    const rows = [head];
    state.results.filter(Boolean).forEach((r) => {
      r.spots.forEach((s) => {
        const box = s.box >= 0 ? r.marks[s.box] : [null, null, null, null];
        rows.push([state.participant, r.pairId, r.fileA, r.fileB, 'difference', s.label, s.type,
          ...s.bbox, ...box, s.iou.toFixed(4), s.found ? 1 : 0, r.timeMs]);
      });
      r.wrong.forEach((mi) => {
        rows.push([state.participant, r.pairId, r.fileA, r.fileB, 'wrong_box', '', '',
          null, null, null, null, ...r.marks[mi], 0, 0, r.timeMs]);
      });
    });
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  function download(text, type, ext) {
    const who = (state.participant || 'anonymous').replace(/[^\w-]+/g, '_');
    const stamp = (state.finishedAt || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spot-the-difference_${who}_${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('btn-json').addEventListener('click', () => download(JSON.stringify(exportObject(), null, 2), 'application/json', 'json'));
  $('btn-csv').addEventListener('click', () => download(exportCsv(), 'text/csv', 'csv'));

  // ---------------------------------------------------------------------------
  initStart();
  show('start');
})();
