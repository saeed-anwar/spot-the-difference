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
    pairsPerRun: 5,      // how many pairs each run draws at random (0 = use every pair)
    // Draw pairs in proportion to how many differences they have, so every run has the same
    // difficulty mix (with the current 55 pairs: 2 pairs with 1 difference, 3 with 2).
    balanceByDifficulty: true,
    showModelsAfterEachPair: true,  // show the AI models' scores and boxes after each answer
    showModelsLink: true,           // show the "See how the AI models scored" link on the start screen
    // When a player wins a trophy on a pair:
    //   'all' = their score is higher than every AI model's score on that pair
    //   'any' = their score is higher than at least one AI model's score
    trophyRule: 'all',
    minBoxSize: 2,       // boxes narrower or shorter than this (in picture pixels) are ignored
    storageKey: 'spot-the-difference:session:v1',
  };

  const PAIRS = Array.isArray(window.PAIRS) ? window.PAIRS : [];
  const MODELS = Array.isArray(window.MODELS) ? window.MODELS : [];

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
  // AI models (scored on the fly with the same rules as players)
  // ---------------------------------------------------------------------------
  const stemOf = (pair) => pair.a.split('/').pop().replace(/_a\.\w+$/i, '');
  const pairById = (id) => PAIRS.find((p) => p.id === id);
  const modelCache = new Map();

  function modelResult(mi, pair) {
    const key = `${mi}:${pair.id}`;
    if (modelCache.has(key)) return modelCache.get(key);
    const boxes = MODELS[mi] && MODELS[mi].pairs ? MODELS[mi].pairs[stemOf(pair)] : null;
    let result = null;
    if (Array.isArray(boxes)) {
      const marks = boxes.map((b) => b.slice());
      result = {
        pairId: pair.id,
        fileA: pair.a.split('/').pop(),
        fileB: pair.b.split('/').pop(),
        width: pair.width,
        height: pair.height,
        marks,
        ...scorePair(marks, spotsFor(pair), CONFIG.iouThreshold),
      };
    }
    modelCache.set(key, result);
    return result;
  }

  // One number per pair: accuracy x mean IoU, out of 100.
  const pairScore = (r) => (r ? Math.round(100 * r.accuracy * r.meanIou) : null);
  const fmtScore = (v) => (v == null ? '–' : String(Math.round(v)));

  const TROPHY_SVG = '<svg class="trophy" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M7 3h10v6a5 5 0 0 1-10 0z"/>' +
    '<path class="handles" d="M7 5H4.6v1.6A3.4 3.4 0 0 0 8 10M17 5h2.4v1.6A3.4 3.4 0 0 1 16 10"/>' +
    '<path d="M11 13.8h2v3.4h-2z"/>' +
    '<rect x="7.5" y="17" width="9" height="3.4" rx="1"/></svg>';

  // Did the player beat the AI models on this pair? Returns { won, best, models }.
  function trophyFor(pair, yourResult) {
    const mine = pairScore(yourResult);
    const models = MODELS.map((m, mi) => ({ name: m.short || m.name, score: pairScore(modelResult(mi, pair)) }))
      .filter((m) => m.score != null);
    if (mine == null || !models.length) return { won: false, mine, models, best: null };
    const beaten = models.filter((m) => mine > m.score);
    const won = CONFIG.trophyRule === 'any' ? beaten.length > 0 : beaten.length === models.length;
    const best = models.reduce((a, m) => (m.score > a.score ? m : a), models[0]);
    return { won, mine, models, best };
  }

  // ---------------------------------------------------------------------------
  // State (saved in this browser so a refresh doesn't lose progress)
  // ---------------------------------------------------------------------------
  const pairIds = PAIRS.map((p) => p.id);
  let state = null;
  let viewing = 'you';   // whose boxes are drawn after checking: 'you' or a model index

  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Pairs every model has an answer for, so trophies are always a fair fight.
  function eligiblePairs() {
    const all = PAIRS.map((_, i) => i);
    const covered = all.filter((i) => MODELS.every((m) => m.pairs && Array.isArray(m.pairs[stemOf(PAIRS[i])])));
    return covered.length ? covered : all;
  }

  function drawPairs() {
    const pool = eligiblePairs();
    const n = CONFIG.pairsPerRun > 0 ? Math.min(CONFIG.pairsPerRun, pool.length) : pool.length;
    if (!CONFIG.balanceByDifficulty) return shuffled(pool).slice(0, n);

    // Group by number of differences and give each group its share of the n slots
    // (largest remainder), then draw at random inside each group.
    const groups = new Map();
    pool.forEach((i) => {
      const k = PAIRS[i].differences.length;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const keys = [...groups.keys()].sort((a, b) => a - b);
    const quota = keys.map((k) => (n * groups.get(k).length) / pool.length);
    const take = quota.map(Math.floor);
    let left = n - take.reduce((a, b) => a + b, 0);
    quota.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
      if (left > 0 && take[i] < groups.get(keys[i]).length) { take[i] += 1; left -= 1; }
    });
    const picked = [];
    keys.forEach((k, i) => picked.push(...shuffled(groups.get(k)).slice(0, take[i])));
    return shuffled(picked);
  }

  function freshState(participant) {
    const order = drawPairs();
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
  const screens = { start: $('screen-start'), play: $('screen-play'), done: $('screen-done'), models: $('screen-models') };
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
    $('method').hidden = !(name === 'done' || name === 'models');
    window.scrollTo(0, 0);
  }

  function initStart() {
    document.querySelectorAll('.threshold').forEach((el) => { el.textContent = CONFIG.iouThreshold.toFixed(2); });
    if (!PAIRS.length) {
      $('no-data').hidden = false;
      $('start-form').hidden = true;
      return;
    }
    const perRun = CONFIG.pairsPerRun > 0 ? Math.min(CONFIG.pairsPerRun, eligiblePairs().length) : eligiblePairs().length;
    $('start-count').textContent = perRun < PAIRS.length
      ? `Each run picks ${perRun} pairs at random from ${PAIRS.length}. It takes a couple of minutes.`
      : `There are ${PAIRS.length} pairs. It takes a few minutes.`;
    $('models-link').hidden = !(CONFIG.showModelsLink && MODELS.length);
    const saved = loadSaved();
    if (saved && !saved.finishedAt && (saved.pos > 0 || saved.marks.length || saved.checked)) {
      $('resume').hidden = false;
      $('resume-detail').textContent = `on pair ${Math.min(saved.pos + 1, saved.order.length)} of ${saved.order.length}`;
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
    viewing = 'you';
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
    renderCabinet();

    if (state.checked && state.results[state.pos]) {
      showFeedback();
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

  let newTrophyPos = -1;   // the slot that should play the award animation once

  function trophyList() {
    return state.order.map((idx, i) => {
      const r = state.results[i];
      return r ? trophyFor(PAIRS[idx], r).won : false;
    });
  }

  function fillShelf(shelf, won, currentPos) {
    shelf.innerHTML = '';
    won.forEach((w, i) => {
      const li = document.createElement('li');
      if (w) li.classList.add('is-won');
      if (i === currentPos) li.classList.add('is-current');
      if (i === newTrophyPos && w) li.classList.add('is-new');
      li.innerHTML = `${TROPHY_SVG}<span class="slot-num">${i + 1}</span>`;
      const label = `Pair ${i + 1}: ${w ? 'trophy won' : state.results[i] ? 'no trophy' : 'not played yet'}`;
      li.setAttribute('aria-label', label);
      li.title = label;
      shelf.appendChild(li);
    });
  }

  function renderCabinet() {
    const cabinet = $('cabinet');
    cabinet.hidden = !MODELS.length;
    if (!MODELS.length) return;
    const won = trophyList();
    const count = won.filter(Boolean).length;
    $('cabinet-count').innerHTML = `<b>${count}</b> of ${won.length}`;
    fillShelf($('shelf'), won, state.pos);
    $('shelf').style.setProperty('--slots', String(won.length <= 6 ? won.length : 4));
    $('cabinet-rule').textContent = CONFIG.trophyRule === 'any'
      ? 'Score higher than at least one AI model on a pair to win its trophy.'
      : 'Score higher than every AI model on a pair to win its trophy.';
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

  function tag(box, text, cls, pair, scale, right) {
    const size = 20 / scale;
    const font = 13 / scale;
    const [bx, y, w, h] = box;
    // Difference numbers sit above the top-left corner; wrong-box marks below the bottom-right,
    // so the two never cover each other.
    const x = right ? bx + w - size : bx;
    let ty;
    if (right) {
      ty = y + h + 1 / scale;
      if (ty + size > pair.height) ty = Math.max(0, y - size - 1 / scale);
    } else {
      ty = y - size - 1 / scale;
      if (ty < 0) ty = Math.min(y + h + 1 / scale, pair.height - size);
    }
    const tx = clamp(x, 0, pair.width - size);
    return `<rect class="ov-tag-bg ${cls}" x="${tx}" y="${ty}" width="${size}" height="${size}" rx="${3 / scale}"/>` +
      `<text class="ov-tag" x="${tx + size / 2}" y="${ty + size / 2}" font-size="${font}" text-anchor="middle" dominant-baseline="central">${text}</text>`;
  }

  // The players shown in the score table for the current pair: you, then each model.
  function pairPlayers() {
    const pair = currentPair();
    const list = [{ key: 'you', name: 'You', short: 'You', result: state.results[state.pos] }];
    if (CONFIG.showModelsAfterEachPair) {
      MODELS.forEach((m, mi) => list.push({ key: mi, name: m.name, short: m.short || m.name, result: modelResult(mi, pair) }));
    }
    return list;
  }

  function viewedResult() {
    const p = pairPlayers().find((x) => x.key === viewing);
    return p && p.result ? p.result : state.results[state.pos];
  }

  function drawOverlays() {
    if (!state || state.pos >= state.order.length) return;
    const pair = currentPair();
    const width = svgA.getBoundingClientRect().width || 1;
    const scale = width / pair.width;
    let html = '';

    const result = state.checked ? viewedResult() : null;
    if (result) {
      const wrongSet = new Set(result.wrong);
      result.spots.forEach((s) => { html += rect(s.bbox, `ov-truth ${s.found ? 'is-right' : 'is-missed'}`); });
      result.marks.forEach((m, i) => { html += rect(m, `ov-mark ${wrongSet.has(i) ? 'is-wrong' : 'is-right'}`); });
      result.spots.forEach((s, i) => { html += tag(s.bbox, String(i + 1), s.found ? 'is-right' : 'is-missed', pair, scale); });
      result.wrong.forEach((mi) => { html += tag(result.marks[mi], '×', 'is-wrong', pair, scale, true); });
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
    state.results[state.pos] = {
      pairId: pair.id,
      fileA: pair.a.split('/').pop(),
      fileB: pair.b.split('/').pop(),
      width: pair.width,
      height: pair.height,
      timeMs: Date.now() - (state.pairStart || Date.now()),
      marks,
      ...scored,
    };
    state.checked = true;
    viewing = 'you';
    save();
    newTrophyPos = trophyFor(pair, state.results[state.pos]).won ? state.pos : -1;
    renderProgress();
    renderCabinet();
    newTrophyPos = -1;
    showFeedback();
    drawOverlays();
    $('btn-next').focus({ preventScroll: true });
  }

  function cardDetail(r) {
    return `<span class="sc-detail">Found ${r.tp} of ${r.tp + r.fn}</span>` +
      `<span class="sc-detail">Wrong boxes ${r.fp}</span>` +
      `<span class="sc-detail">Accuracy ${pct(r.accuracy)}</span>` +
      `<span class="sc-detail">IoU ${dec(r.meanIou)}</span>`;
  }

  function renderPairCards() {
    const players = pairPlayers();
    const pair = currentPair();
    const trophy = trophyFor(pair, state.results[state.pos]);
    const wrap = $('pair-cards');
    wrap.innerHTML = '';
    players.forEach((p) => {
      const r = p.result;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `score-card${p.key === 'you' ? ' is-you' : ''}`;
      btn.setAttribute('aria-pressed', p.key === viewing ? 'true' : 'false');
      btn.title = p.name;
      btn.innerHTML = `<span class="sc-name"><span class="sc-label"></span>${p.key === 'you' && trophy.won ? TROPHY_SVG : ''}</span>` +
        (r ? `<span class="sc-score">${fmtScore(pairScore(r))}</span>${cardDetail(r)}`
           : '<span class="sc-score">–</span><span class="sc-detail">No answer for this pair</span>');
      btn.querySelector('.sc-label').textContent = p.short;
      if (r) btn.addEventListener('click', () => select(p.key));
      else btn.disabled = true;
      wrap.appendChild(btn);
    });
    $('pick-hint').hidden = players.length < 2;
  }

  function renderAward() {
    const award = $('award');
    const t = trophyFor(currentPair(), state.results[state.pos]);
    if (!MODELS.length || !t.models.length) { award.hidden = true; return; }
    award.hidden = false;
    award.classList.toggle('is-won', t.won);
    let text;
    if (t.won) {
      text = CONFIG.trophyRule === 'any'
        ? `Trophy won! You scored ${t.mine} and beat at least one AI model.`
        : `Trophy won! Your ${t.mine} beat every AI model on this pair.`;
    } else if (CONFIG.trophyRule === 'any') {
      text = `No trophy this time. Every AI model scored at least ${t.mine}.`;
    } else if (t.best.score === t.mine) {
      text = `No trophy this time. You tied with ${t.best.name} at ${t.mine}. Beat it to win one.`;
    } else {
      text = `No trophy this time. ${t.best.name} scored ${t.best.score}, you scored ${t.mine}.`;
    }
    award.innerHTML = `${TROPHY_SVG}<span></span>`;
    award.querySelector('span').textContent = text;
  }

  function select(key) {
    if (viewing === key) return;
    viewing = key;
    renderPairCards();
    renderFindings();
    drawOverlays();
    const btn = $('pair-cards').querySelector('[aria-pressed="true"]');
    if (btn) btn.focus({ preventScroll: true });
  }

  function renderFindings() {
    const player = pairPlayers().find((p) => p.key === viewing) || pairPlayers()[0];
    const result = player.result;
    $('findings-title').textContent = player.key === 'you' ? 'Your boxes' : `${player.name}’s boxes`;
    const ul = $('findings');
    ul.innerHTML = '';
    if (!result) return;

    result.spots.forEach((s, i) => {
      const li = document.createElement('li');
      const status = s.found ? 'is-right' : 'is-missed';
      let note;
      if (s.found) note = `IoU ${dec(s.iou)}`;
      else if (s.iou > 0) note = `Closest box: IoU ${dec(s.iou)}, needs ${CONFIG.iouThreshold.toFixed(2)}`;
      else note = 'No box on it';
      li.innerHTML = `<span class="tag ${status}">${i + 1}</span>` +
        '<span class="finding-text"><span class="finding-label"></span><span class="finding-note"></span></span>' +
        `<span class="finding-status ${status}">${s.found ? 'Found' : 'Missed'}</span>`;
      li.querySelector('.finding-label').textContent = s.label;
      li.querySelector('.finding-note').textContent = note;
      ul.appendChild(li);
    });

    if (result.wrong.length) {
      const li = document.createElement('li');
      const n = result.wrong.length;
      li.innerHTML = '<span class="tag is-wrong">×</span>' +
        `<span class="finding-text">${n === 1 ? 'A box with no difference under it' : `${n} boxes with no difference under them`}</span>` +
        `<span class="finding-status is-wrong">${n === 1 ? 'Wrong box' : 'Wrong boxes'}</span>`;
      ul.appendChild(li);
    }
  }

  function showFeedback() {
    canvases.forEach((c) => c.classList.add('is-locked'));
    $('controls').hidden = true;
    renderAward();
    renderPairCards();
    renderFindings();
    $('btn-next').textContent = state.pos + 1 >= state.order.length ? 'See results' : 'Next pair';
    $('feedback').hidden = false;
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
  // Results tables
  // ---------------------------------------------------------------------------
  function summarise(results) {
    const rs = results.filter(Boolean);
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

  // players: [{ name, short, isYou, resultFor(pair) }]
  function renderOverallCards(wrap, players, pairs) {
    wrap.innerHTML = '';
    players.forEach((p) => {
      const results = pairs.map((pair) => p.resultFor(pair)).filter(Boolean);
      const s = summarise(results);
      const score = results.length ? results.reduce((a, r) => a + pairScore(r), 0) / results.length : null;
      const card = document.createElement('div');
      card.className = `score-card${p.isYou ? ' is-you' : ''}`;
      card.innerHTML = '<span class="sc-name"><span class="sc-label"></span></span>' + (s.pairs
        ? `<span class="sc-score">${fmtScore(score)}</span>` +
          `<span class="sc-detail">Accuracy ${pct(s.accuracy)}</span>` +
          `<span class="sc-detail">Mean IoU ${dec(s.mean_iou)}</span>` +
          `<span class="sc-detail">Precision ${pct(s.precision)}</span>` +
          `<span class="sc-detail">Recall ${pct(s.recall)}</span>` +
          `<span class="sc-detail">Solved ${s.pairs_solved} of ${s.pairs} pairs</span>`
        : '<span class="sc-score">–</span><span class="sc-detail">No answers for these pairs</span>');
      card.querySelector('.sc-label').textContent = p.name;
      wrap.appendChild(card);
    });
  }

  function renderPairs(table, players, pairs) {
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    ['Pair', ...players.map((p) => p.short)].forEach((label, i) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      if (i >= 1) { th.className = 'num'; th.title = players[i - 1].name; }
      hr.appendChild(th);
    });
    head.appendChild(hr);
    const tbody = document.createElement('tbody');
    pairs.forEach((pair) => {
      const tr = document.createElement('tr');
      const tdPair = document.createElement('th');
      tdPair.scope = 'row';
      tdPair.innerHTML = '<span class="pair-what"></span><span class="pair-id"></span>';
      tdPair.querySelector('.pair-what').textContent = pair.differences.map(describe).join('; ');
      tdPair.querySelector('.pair-id').textContent = stemOf(pair);
      tr.append(tdPair);
      players.forEach((p) => {
        const r = p.resultFor(pair);
        const td = document.createElement('td');
        td.className = 'num player';
        const won = p.isYou && r && trophyFor(pair, r).won;
        td.innerHTML = r
          ? `<span class="cell-score is-${r.status}">${won ? TROPHY_SVG : ''}${fmtScore(pairScore(r))}</span>` +
            `<span class="cell-sub"><span>${pct(r.accuracy)}</span><span class="cs-sep">, </span><span>IoU ${dec(r.meanIou)}</span></span>`
          : '<span class="cell-sub">No answer</span>';
        if (won) td.title = 'Trophy won';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.innerHTML = '';
    table.append(head, tbody);
  }

  const modelPlayers = () => MODELS.map((m, mi) => ({
    name: m.name,
    short: m.short || m.name,
    isYou: false,
    resultFor: (pair) => modelResult(mi, pair),
  }));

  function finish() {
    if (!state.finishedAt) state.finishedAt = new Date().toISOString();
    state.pos = state.order.length;
    save();
    $('done-title').textContent = `All ${state.order.length} pairs done`;
    const you = summarise(state.results);
    const wrongText = you.wrong_boxes === 0 ? 'and no wrong boxes' : you.wrong_boxes === 1 ? 'with 1 wrong box' : `with ${you.wrong_boxes} wrong boxes`;
    $('done-sentence').textContent = `You found ${you.found} of ${you.differences} differences, ${wrongText}.`;

    const won = trophyList();
    const count = won.filter(Boolean).length;
    $('done-cabinet').hidden = !MODELS.length;
    $('done-cabinet-count').innerHTML = `<b>${count}</b> of ${won.length}`;
    fillShelf($('done-shelf'), won, -1);

    const donePairs = state.results.filter(Boolean).map((r) => pairById(r.pairId)).filter(Boolean);
    const byPair = new Map(state.results.filter(Boolean).map((r) => [r.pairId, r]));
    const players = [{ name: 'You', short: 'You', isYou: true, resultFor: (pair) => byPair.get(pair.id) || null }, ...modelPlayers()];
    renderOverallCards($('done-cards'), players, donePairs);
    renderPairs($('done-pairs'), players, donePairs);
    show('done');
  }

  function showModels() {
    $('models-lede').textContent = `Scored on all ${PAIRS.length} pairs on this site, with the same rules as players.`;
    renderOverallCards($('models-cards'), modelPlayers(), PAIRS);
    renderPairs($('models-pairs'), modelPlayers(), PAIRS);
    show('models');
  }

  $('btn-models').addEventListener('click', showModels);
  $('btn-models-back').addEventListener('click', () => show('start'));

  $('btn-restart').addEventListener('click', () => {
    const participant = state ? state.participant : '';
    clearSaved();
    state = freshState(participant);
    save();
    startPlay();
  });

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------
  function pairExport(r, extra) {
    return {
      pair_id: r.pairId,
      file_a: r.fileA,
      file_b: r.fileB,
      ...extra,
      result: r.status,
      score: pairScore(r),
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
    };
  }

  function exportObject() {
    const done = state.results.filter(Boolean);
    const donePairs = done.map((r) => pairById(r.pairId)).filter(Boolean);
    return {
      participant_id: state.participant || null,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      iou_threshold: CONFIG.iouThreshold,
      pairs_in_run: state.order.map((i) => stemOf(PAIRS[i])),
      box_format: '[x, y, width, height] in original image pixels',
      trophy_rule: CONFIG.trophyRule,
      summary: {
        ...summarise(done),
        score: done.length ? done.reduce((a, r) => a + pairScore(r), 0) / done.length : null,
        trophies: done.filter((r) => trophyFor(pairById(r.pairId), r).won).length,
      },
      pairs: done.map((r) => pairExport(r, {
        image_width: r.width,
        image_height: r.height,
        time_ms: r.timeMs,
        trophy: trophyFor(pairById(r.pairId), r).won,
      })),
      models: MODELS.map((m, mi) => {
        const rs = donePairs.map((pair) => modelResult(mi, pair)).filter(Boolean);
        const score = rs.length ? rs.reduce((a, r) => a + pairScore(r), 0) / rs.length : null;
        return { name: m.name, summary: { ...summarise(rs), score }, pairs: rs.map((r) => pairExport(r, {})) };
      }),
    };
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const CSV_HEAD = ['player', 'participant_id', 'pair_id', 'file_a', 'file_b', 'row_type', 'description', 'change_type',
    'truth_x', 'truth_y', 'truth_w', 'truth_h', 'box_x', 'box_y', 'box_w', 'box_h', 'iou', 'found', 'pair_score', 'trophy', 'time_ms'];

  function csvRows(player, participant, results) {
    const rows = [];
    results.filter(Boolean).forEach((r) => {
      const time = r.timeMs == null ? null : r.timeMs;
      const score = pairScore(r);
      const trophy = player === 'human' ? (trophyFor(pairById(r.pairId), r).won ? 1 : 0) : null;
      r.spots.forEach((s) => {
        const box = s.box >= 0 ? r.marks[s.box] : [null, null, null, null];
        rows.push([player, participant, r.pairId, r.fileA, r.fileB, 'difference', s.label, s.type,
          ...s.bbox, ...box, s.iou.toFixed(4), s.found ? 1 : 0, score, trophy, time]);
      });
      r.wrong.forEach((mi) => {
        rows.push([player, participant, r.pairId, r.fileA, r.fileB, 'wrong_box', '', '',
          null, null, null, null, ...r.marks[mi], 0, 0, score, trophy, time]);
      });
    });
    return rows;
  }

  const toCsv = (rows) => [CSV_HEAD, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

  function download(text, type, filename) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sessionFilename(ext) {
    const who = (state.participant || 'anonymous').replace(/[^\w-]+/g, '_');
    const stamp = (state.finishedAt || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
    return `spot-the-difference_${who}_${stamp}.${ext}`;
  }

  $('btn-json').addEventListener('click', () => {
    download(JSON.stringify(exportObject(), null, 2), 'application/json', sessionFilename('json'));
  });
  $('btn-csv').addEventListener('click', () => {
    const done = state.results.filter(Boolean);
    const donePairs = done.map((r) => pairById(r.pairId)).filter(Boolean);
    let rows = csvRows('human', state.participant, done);
    MODELS.forEach((m, mi) => { rows = rows.concat(csvRows(m.name, '', donePairs.map((pair) => modelResult(mi, pair)))); });
    download(toCsv(rows), 'text/csv', sessionFilename('csv'));
  });
  $('btn-models-csv').addEventListener('click', () => {
    let rows = [];
    MODELS.forEach((m, mi) => { rows = rows.concat(csvRows(m.name, '', PAIRS.map((pair) => modelResult(mi, pair)))); });
    download(toCsv(rows), 'text/csv', `model-scores_${new Date().toISOString().slice(0, 10)}.csv`);
  });

  // ---------------------------------------------------------------------------
  initStart();
  show('start');
})();
