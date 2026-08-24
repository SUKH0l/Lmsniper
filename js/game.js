/* ============================================================
 * game.js — LMSNIPER 메인 게임 로직 / 렌더링 / 입력
 * 좌표: 탄도계와 동일 (x 사거리, y 상방, z 우측).
 * 화면각 단위: mrad (mil). 1 mil = 사거리 1km에서 1m.
 *
 * 배경 에셋 파이프라인:
 *   assets/bg-<terrain>.jpg 파일이 존재하면 실사 파노라마 배경으로
 *   사용한다 (BG_META로 각도 매핑). 없으면 절차적 장면을 그린다.
 * ============================================================ */
'use strict';

(() => {
  const canvas = document.getElementById('scope-canvas');
  let ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);
  const windCv = $('wind-canvas'), windCx = windCv.getContext('2d');
  const histCv = $('wind-history'), histCx = histCv.getContext('2d');

  /* ---------------- 게임 상태 ---------------- */
  const S = {
    phase: 'menu',
    rifle: null, ammo: null, mission: null,
    zeroAngle: 0,
    aim: { yaw: 0, pitch: 0 },
    sway: { yaw: 0, pitch: 0 },
    recoil: { yaw: 0, pitch: 0 },
    dial: { elev: 0, wind: 0 },     // 클릭 수 (1클릭 = 0.1 mil)
    mag: 12,
    reticle: 'mildot',              // 선택 레티클 (총기 선택 화면에서 변경)
    retStyle: 'red',                // 레티클 색 (설정 / V 키)
    pointerLocked: false,
    controlMode: 'drag',   // 'drag' | 'look' — C 키로 토글
    magazine: 0, canFireAt: 0,
    /* 라운드제: 임무당 rounds회, 라운드당 shotsPerRound발 (기본 3발).
     * 탄환 소진 시 라운드 실패. 제한시간 없음. */
    roundsTotal: 5, roundIdx: 0, roundResults: [], roundShots: [], shotsPerRound: 3,
    breathPhase: 0, o2: 100, holdingBreath: false, recovering: 0,
    heartRate: 70, heartPhase: 0,
    windNow: 0, windDirNow: 0, windNoiseT: 0,
    windMeas: 0, windDirMeas: 0,       // 풍속계 표시값 (센서 지연/오차)
    windHist: [],                       // {t, v}
    shots: [], activeShot: null,
    impactMarks: [], puffs: [],
    score: 0, firedTotal: 0,
    spotterNoise: { wind: 0, dir: 0, elev: 0 },
    lastHudUpdate: 0, shakeT: 0,
    msg: '', msgUntil: 0,
    balRows: null,
    sceneSeed: 1,
    targets: [],              // {type:'hostile'|'civilian', dh, z, down, downT, marks[]}
    ending: false,            // 라운드 전환/임무 종료 중 (격발 차단)
    magMin: 5,
    stageScale: 1,
    assistHL: true,     // DOPE 거리 하이라이트 토글
    muted: false,
    navTab: 'simulator',
    bigMsg: null,       // {text, color, until} — HIT/MISS 대형 표시
    fireHold: false,    // 발사 버튼 홀드(숨참기) 중
    _uiClick: false,
  };

  /* ---------------- 유틸 ---------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now() / 1000;
  const fmt = (v, d = 1) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const TAU = Math.PI * 2;
  // 레티클 완성 레이어 캐시 — resize()가 부팅 즉시 비우므로 여기서 선언한다
  const retLayers = new Map();   // key → 캔버스 (삽입 순서로 오래된 것부터 폐기)

  function noise1(t, seed = 0) {
    return (Math.sin(t * 1.7 + seed * 12.9) * 0.5 +
            Math.sin(t * 0.53 + seed * 78.2) * 0.3 +
            Math.sin(t * 3.1 + seed * 37.7) * 0.2);
  }
  // 결정적 해시 난수 (장면 배치용)
  function hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  let gaussSpare = null;
  function gauss() {
    if (gaussSpare != null) { const s = gaussSpare; gaussSpare = null; return s; }
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    gaussSpare = r * Math.sin(TAU * v);
    return r * Math.cos(TAU * v);
  }

  /* ---------------- 오디오 ---------------- */
  let AC = null;
  function audio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
    return AC;
  }
  // 짧은 기계음 도우미: 대역 통과 노이즈 버스트
  function mechBurst(when, freq, dur, vol, q = 6) {
    if (S.muted) return;
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime + when;
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ac.sampleRate * dur * 0.25));
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ac.createGain(); g.gain.setValueAtTime(vol, t);
    src.connect(bp).connect(g).connect(ac.destination); src.start(t);
  }
  function playShot() {
    if (S.muted) return;
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime;
    // 총성: 광대역 노이즈 + 저역 붐
    const buf = ac.createBuffer(1, ac.sampleRate * 0.7, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const e = Math.exp(-i / (ac.sampleRate * 0.06)) + 0.25 * Math.exp(-i / (ac.sampleRate * 0.28));
      d[i] = (Math.random() * 2 - 1) * e;
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.5);
    const g = ac.createGain(); g.gain.setValueAtTime(0.65, t);
    src.connect(lp).connect(g).connect(ac.destination); src.start(t);
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    og.gain.setValueAtTime(0.55, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og).connect(ac.destination); o.start(t); o.stop(t + 0.45);
  }
  function playClick() { mechBurst(0, 3400, 0.03, 0.18, 8); }          // 터렛 클릭
  function playDry() { mechBurst(0, 1400, 0.05, 0.3, 5); }             // 공이치기 (빈 총)
  function playBolt(isSemi) {
    if (isSemi) { mechBurst(0.12, 700, 0.09, 0.35, 3); return; }       // 반자동 노리쇠 왕복
    mechBurst(0.55, 900, 0.07, 0.3, 4);   // 볼트 열기
    mechBurst(0.75, 650, 0.06, 0.25, 4);  // 후퇴
    mechBurst(1.05, 800, 0.08, 0.35, 3);  // 전진·폐쇄
  }
  // 바람 앰비언스: 저역 노이즈 루프, 풍속에 볼륨/음색 연동
  let windAmb = null;
  function startWindAmbience() {
    const ac = audio(); if (!ac || windAmb) return;
    const len = ac.sampleRate * 3;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.04; d[i] = lp * 3; }
    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 0.6;
    const g = ac.createGain(); g.gain.value = 0;
    src.connect(bp).connect(g).connect(ac.destination); src.start();
    windAmb = { gain: g, filter: bp };
  }
  function updateWindAmbience() {
    if (!windAmb || !AC) return;
    if (S.muted) { windAmb.gain.gain.setTargetAtTime(0, AC.currentTime, 0.2); return; }
    const w = S.windShooterNow ?? S.windNow;
    const target = clamp(w / 14, 0, 1) * 0.22;
    windAmb.gain.gain.setTargetAtTime(S.phase === 'play' ? target : 0, AC.currentTime, 0.4);
    windAmb.filter.frequency.setTargetAtTime(280 + w * 45, AC.currentTime, 0.6);
  }
  function playDing(delay) {
    if (S.muted) return;
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime + delay;
    [1567, 2349].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f * (1 + 0.003 * i);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25 / (i + 1), t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 1.3);
    });
  }
  function playThud(delay) {
    if (S.muted) return;
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.35);
  }

  /* ---------------- 기하 / 탄도 헬퍼 ---------------- */
  function geom() {
    const m = S.mission;
    const incl = m.env.inclineDeg * Math.PI / 180;
    const D = m.distanceM;
    return {
      incl,
      Dh: D * Math.cos(incl),
      ty: D * Math.sin(incl),
      halfW: m.target.widthM / 2,
      halfH: m.target.heightM / 2,
    };
  }
  function ammoParams(mvOverride) {
    return {
      mv: mvOverride ?? S.ammo.mv,
      bc: S.ammo.bc,
      dragModel: S.ammo.dragModel,
      sgFactor: S.ammo.sgFactor,
      spinDriftSign: 1,
    };
  }

  /* 레티클에 가장 가까운 생존 표적 (25 mil 이내) — 레이저 측거 대상 */
  function aimedTarget() {
    let best = null, bd = 25;
    for (const tg of S.targets) {
      if (tg.down) continue;
      const d = Math.hypot(tg.yawC - S.aim.yaw, tg.centerPit - S.aim.pitch);
      if (d < bd) { bd = d; best = tg; }
    }
    return best;
  }
  function aimedDist() {
    const at = aimedTarget();
    return at ? at.dist : S.mission.distanceM;
  }

  /* ── 표 공용: 거리 범위/간격 (탄도표·측거표) ── */
  function tableRange() {
    const dists = S.map.anchors.map(a => a.dist);
    const hi = Math.min(
      Math.ceil(Math.max(...dists) * 1.15 / 25) * 25,
      Math.round(S.rifle.effectiveRangeM * 1.5 / 25) * 25);
    const span = hi - 100;
    const step = span > 1200 ? 100 : span > 600 ? 50 : 25;
    return { lo: 100, hi, step };
  }

  /* ── 탄도표 (LRS 스타일): 거리별 낙차·편류 제원 ──
   * DROP: 100m 영점 기준 낙차 보정 [mrad]
   * WIND: full-value 측풍 1㎧당 편류 [mrad]
   * CB DROP: 지구 곡률에 의한 추가 낙차 [mrad]
   * SPIN: 자이로 스핀 편류 [mrad]
   * EOTV: 코리올리 수직 성분(에트뵈시) [mrad] · CORI: 수평 성분 [mrad]
   * LEAD: 횡속 1㎧ 표적 리드량 [mrad] · TOF: 비행시간 [s]
   * 시뮬레이션 3회(기본/측풍 1㎧/코리올리 OFF)로 전 열을 계산한다. */
  function buildBallistic() {
    const p = ammoParams();
    const env0 = { ...S.mission.env, windSpeed: 0, coriolis: true };
    const launch = { elevRad: S.zeroAngle, azRad: 0 };
    const { lo, hi, step } = tableRange();
    const opts = { maxRangeM: hi + 30, dt: 0.004, recordPath: true };
    const base = Ballistics.simulate(p, env0, launch, opts).path;
    const wind1 = Ballistics.simulate(p,
      { ...env0, windSpeed: 1, windFromDeg: env0.fireAzimuthDeg + 90 }, launch, opts).path;
    const nocor = Ballistics.simulate(p, { ...env0, coriolis: false }, launch, opts).path;
    const at = (path, xq) => {
      if (!path || xq > path[path.length - 1].x) return null;
      let l = 0, h = path.length - 1;
      while (h - l > 1) { const m = (l + h) >> 1; (path[m].x <= xq) ? l = m : h = m; }
      const a = path[l], b = path[h];
      const f = b.x > a.x ? (xq - a.x) / (b.x - a.x) : 0;
      return { y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), t: lerp(a.t, b.t, f) };
    };
    const sg = S.ammo.sgFactor ?? 1.9;
    const rows = [];
    for (let d = lo; d <= hi; d += step) {
      const b = at(base, d); if (!b) break;
      const w = at(wind1, d), n = at(nocor, d);
      const mil = v => v / d * 1000;
      rows.push({
        d,
        drop: Math.max(0, -mil(b.y)),
        wind: w ? Math.abs(mil(w.z - b.z)) : 0,
        cb: -(d / (2 * 6.371e6)) * 1000,
        spin: mil(1.25 * (sg + 1.2) * Math.pow(b.t, 1.83) * 0.0254),
        eotv: n ? mil(b.y - n.y) : 0,
        cori: n ? mil(b.z - n.z) : 0,
        lead: mil(b.t * 1.0),
        tof: b.t,
      });
    }
    S.balRows = rows;
    renderBallistic();
  }
  function renderBallistic(distHint) {
    if (!S.balRows) return;
    const env = S.mission.env;
    const D = S.assistHL ? (distHint || S.mission.distanceM) : null;
    let best = -1, bd = 1e9;
    if (D != null) S.balRows.forEach((r, i) => { const d = Math.abs(r.d - D); if (d < bd) { bd = d; best = i; } });
    const head =
      `<div class="tbl-head">${S.ammo.caliber.toUpperCase()} — ` +
      `T ${fmt(env.tempC, 0)}℃ P ${fmt(Ballistics.pressureAtAltitude(env.altitudeM), 0)}hPa U ${fmt(env.rhPct, 0)}% — ` +
      `LAT ${fmt(env.latitudeDeg, 0)} AZI ${fmt(env.fireAzimuthDeg, 0)}°</div>`;
    let html = head + '<table><tr>' +
      '<th>DIST<br><small>m</small></th>' +
      '<th>DROP<br><small>mrad</small></th>' +
      '<th>WIND<br><small>mrad 1㎧→</small></th>' +
      '<th>CB<br>DROP<br><small>mrad</small></th>' +
      '<th>SPIN<br>DRIFT<br><small>mrad</small></th>' +
      '<th>EOTV<br>DROP<br><small>mrad</small></th>' +
      '<th>CORI<br>DRIFT<br><small>mrad</small></th>' +
      '<th>LEAD<br><small>mrad 1㎧←</small></th>' +
      '<th>TOF<br><small>s</small></th></tr>';
    S.balRows.forEach((r, i) => {
      html += `<tr${i === best ? ' class="cur"' : ''}><td>${r.d}</td>` +
        `<td>${r.drop.toFixed(2)}</td><td>${r.wind.toFixed(2)}</td>` +
        `<td>${r.cb.toFixed(2)}</td><td>${r.spin.toFixed(2)}</td>` +
        `<td>${r.eotv.toFixed(2)}</td><td>${r.cori.toFixed(2)}</td>` +
        `<td>${r.lead.toFixed(2)}</td><td>${r.tof.toFixed(2)}</td></tr>`;
    });
    html += '</table>';
    for (const id of ['dope-table', 'bal-table']) {
      const el = $(id); if (!el) continue;
      el.innerHTML = html;
      const cur = el.querySelector('tr.cur');
      if (cur) el.scrollTop = Math.max(0, cur.offsetTop - el.clientHeight / 2);
    }
  }

  /* ---------------- 배경 사진 파이프라인 ---------------- */
  // assets/bg-<terrain>.jpg 가 있으면 실사 배경 사용.
  //  mradW: 사진 가로 전체가 커버하는 각도 [mrad]
  //  cFrac: 조준선(LOS) 높이에 해당하는 사진 세로 위치 (0=위) — 평지에선 지평선
  //  mradW는 사진 속 구조물의 실제 크기(픽셀 대비)로 역산해 표적 원근과 일치시킴.
  //  magMin: 사진 세로 커버 한계로 결정되는 최소 배율.
  const BG_META = {
    farm:     { mradW: 80,  cFrac: 0.62, xFrac: 0.80, magMin: 7, w: 1280, h: 720 },  // 헛간 ~9 m
    forest:   { mradW: 70,  cFrac: 0.47, magMin: 6, w: 2400, h: 1600 },              // 유칼립투스 ~15 m
    plains:   { mradW: 56,  cFrac: 0.68, magMin: 9, w: 717,  h: 427 },               // 아카시아 ~7 m
    mountain: { mradW: 140, cFrac: 0.55, magMin: 5, w: 960,  h: 533 },               // 계곡 오두막 ~4 m
    desert:   { mradW: 105, cFrac: 0.47, magMin: 5, w: 2400, h: 1372 },              // 야자수 ~8 m
    tundra:   { mradW: 85,  cFrac: 0.34, magMin: 5, w: 1000, h: 667 },               // 침엽수 ~12 m
    kasbah:   { mradW: 75,  cFrac: 0.50, magMin: 7, w: 1920, h: 1100 },              // 건물 2~3층 ~10 m
    _default: { mradW: 95,  cFrac: 0.46, magMin: 5, w: 1600, h: 1000 },
  };
  const BG = {};

  /* ── 배경 기준 각도 한계 ──
   * 배경 사진이 커버하는 각도 범위(mradW × mradH)를 기준으로,
   * 스코프 원(반지름 R)이 배경 가장자리에 닿는 지점까지만 카메라를
   * 허용한다. 배율이 낮을수록 시야가 넓어 한계가 좁아진다.
   * 표적은 어느 배율에서든 조준 가능해야 하므로 표적 범위만큼 확장. */
  function bgMradH(meta) { return meta.mradW * meta.h / meta.w; }
  function aimLimits(mag) {
    const meta = S.bgMeta || BG_META._default;
    const R = Math.min(BASE_W, BASE_H) * 0.44;
    const ppm = BASE_H / (16 / mag * 17.4533);
    const half = R / ppm; // 스코프 원 반경 [mrad]
    const mradW = meta.mradW, mradH = bgMradH(meta);
    const xF = meta.xFrac ?? 0.5, cF = meta.cFrac;
    const L = {
      yawMin: -(xF * mradW - half),
      yawMax: (1 - xF) * mradW - half,
      pitMin: -((1 - cF) * mradH - half),
      pitMax: cF * mradH - half,
    };
    // 표적 전부 + 초기 조준점(0,0)은 항상 도달 가능하게 확장
    const B = S.tgtBox;
    L.yawMin = clamp(Math.min(L.yawMin, B ? B.yawMin - 4 : 0, 0), -80, 0);
    L.yawMax = clamp(Math.max(L.yawMax, B ? B.yawMax + 4 : 0, 0), 0, 80);
    L.pitMin = clamp(Math.min(L.pitMin, B ? B.pitMin - 4 : 0, 0), -80, 0);
    L.pitMax = clamp(Math.max(L.pitMax, B ? B.pitMax + 4 : 0, 0), 0, 80);
    return L;
  }
  function clampAim() {
    const L = aimLimits(S.mag);
    S.aim.yaw = clamp(S.aim.yaw, L.yawMin, L.yawMax);
    S.aim.pitch = clamp(S.aim.pitch, L.pitMin, L.pitMax);
  }

  function tryLoadBg(terrain) {
    if (BG[terrain] !== undefined) return;
    BG[terrain] = null;
    const img = new Image();
    img.onload = () => { BG[terrain] = { img }; };
    img.onerror = () => { BG[terrain] = null; };
    img.src = `assets/bg-${terrain}.jpg`;
  }

  /* ---------------- 게임 시작: 맵 → 랜덤 스테이지 생성 ---------------- */
  const randIn = ([a, b]) => a + (b - a) * Math.random();
  const randInt = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));

  // 상황 풀: [id, 가중치]
  const SITUATIONS = [
    ['none', 0.25], ['hostage', 0.25], ['localwind', 0.2], ['calm', 0.15], ['gustfront', 0.15],
  ];
  function rollSituation() {
    let r = Math.random() * SITUATIONS.reduce((a, x) => a + x[1], 0);
    for (const [id, w] of SITUATIONS) { r -= w; if (r <= 0) return id; }
    return 'none';
  }
  const SITUATION_TEXT = {
    none: '',
    hostage: '⚠ 인질 상황 — 적이 인질을 붙잡고 있다. 인질 피격 = 즉시 실패!',
    localwind: '주의 — 표적 지역 국지풍. 풍속계는 사수 위치 기준이라 표적 쪽 바람과 다를 수 있다. 깃발을 읽어라.',
    calm: '정온 — 바람이 잦아든 창이다. 지금이 기회.',
    gustfront: '돌풍 전선 통과 중 — 바람 변동이 극심하다.',
  };

  function startGame() {
    const map = S.map;
    const meta = BG_META[map.terrain] || BG_META._default;
    const pxm = meta.w / meta.mradW; // 사진 px per mrad

    /* ── 기후 특성 범위 안에서 매판 랜덤 추출 ── */
    const cl = map.climate;
    let gust = randIn(cl.gustiness);
    let windSpd = randIn(cl.windSpeed);
    const situation = rollSituation();
    if (situation === 'calm') { gust *= 0.35; windSpd *= 0.6; }
    if (situation === 'gustfront') { gust = Math.min(0.9, gust * 1.8); }
    const env = {
      tempC: Math.round(randIn(cl.tempC)),
      rhPct: Math.round(randIn(cl.rhPct)),
      windSpeed: +windSpd.toFixed(1),
      windFromDeg: Math.round(Math.random() * 360),
      fireAzimuthDeg: Math.round(Math.random() * 360),
      gustiness: +gust.toFixed(2),
      inclineDeg: 0,
      pressurehPa: null,
      ...map.env, // altitudeM, latitudeDeg, earthCurvature
    };

    /* ── 사수 바람 vs 표적 지역 바람 (국지풍 상황) ── */
    S.windSh = { base: env.windSpeed, dir: env.windFromDeg };
    if (situation === 'localwind') {
      const sgn = Math.random() < 0.5 ? -1 : 1;
      S.windTg = {
        base: Math.max(0.3, env.windSpeed * (1 + sgn * (0.4 + Math.random() * 0.4))),
        dir: env.windFromDeg + (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 30),
      };
    } else {
      S.windTg = { ...S.windSh };
    }

    // 이번 판 스테이지 사본 (정적 맵 정의는 S.map에 보존; distanceM은 라운드마다 갱신)
    S.mission = { ...map, env, distanceM: map.anchors[0].dist, situation };
    S.bgMeta = meta;

    S.zeroAngle = Ballistics.zeroAngle(ammoParams(), env, 100);
    S.aim = { yaw: 0, pitch: 0 };
    S.dial = { elev: 0, wind: 0 };
    S.recoil = { yaw: 0, pitch: 0 };
    S.magMin = meta.magMin || 5;
    S.mag = clamp(12, S.magMin, 25);
    S.shots = []; S.puffs = [];
    S.score = 0; S.firedTotal = 0;
    S.o2 = 100; S.heartRate = 70; S.recovering = 0;
    S.activeShot = null; S.canFireAt = 0;
    S.spotterNoise = { wind: gauss() * 0.5, dir: gauss() * 0.5, elev: gauss() * 0.3 };
    S.windHist = [];
    S.windMeas = env.windSpeed; S.windDirMeas = env.windFromDeg;
    S.sceneSeed = [...map.id].reduce((a, c) => a + c.charCodeAt(0), 7) + Math.floor(Math.random() * 100);
    tryLoadBg(map.terrain);

    /* ── 라운드제 초기화: 제한시간 없음, 탄환 수가 유일한 제약 ── */
    S.roundsTotal = map.rounds ?? 5;
    S.shotsPerRound = map.shotsPerRound ?? S.rifle.shotsPerRound ?? 3;
    S.roundResults = Array(S.roundsTotal).fill('pending');
    S.roundIdx = 0;

    S.phase = 'play';
    $('menu').classList.add('hidden');
    $('result').classList.add('hidden');
    $('game').classList.remove('hidden');
    buildBallistic();
    buildSizes();
    spawnRound();
    updateHelpText();
    updateTouchBar();
    resize();
  }

  /* ── 라운드 시작: 표적 재배치 + 탄환 재지급 ── */
  function spawnRound() {
    const map = S.map, meta = S.bgMeta;
    const pxm = meta.w / meta.mradW;
    const situation = S.mission.situation;
    const hCount = randInt(map.hostiles);
    let cCount = randInt(map.civilians);
    if (situation === 'hostage' && cCount === 0) cCount = 1;
    const pool = [...map.anchors].sort(() => Math.random() - 0.5);
    /* 표적 스폰 한계: 배경 사진 범위 안쪽(가장자리 여유 포함)으로 제한 —
     * 배경 밖/가장자리에 표적이 생성되지 않게 한다. */
    const mradH = bgMradH(meta);
    const xF0 = meta.xFrac ?? 0.5;
    const spawnLim = {
      yawMin: -(xF0 * meta.mradW) + 6, yawMax: (1 - xF0) * meta.mradW - 6,
      pitMin: -((1 - meta.cFrac) * mradH) + 4, pitMax: meta.cFrac * mradH - 4,
    };
    const mkTarget = (type, anchor, latOffM = 0) => {
      const dist = anchor.dist;
      let yawC = ((anchor.xF - xF0) * meta.w) / pxm + (latOffM / dist) * 1000;
      let centerPit = ((meta.h * meta.cFrac) - anchor.yF * meta.h) / pxm + (900 / dist); // 인체 중심(0.9 m) 각높이
      yawC = clamp(yawC, spawnLim.yawMin, spawnLim.yawMax);
      centerPit = clamp(centerPit, spawnLim.pitMin, spawnLim.pitMax);
      const pitFeet = centerPit - (900 / dist);
      return {
        type, dist, dh: dist, yawC, pitFeet, centerPit,
        z: (yawC / 1000) * dist,
        cY: (centerPit / 1000) * dist,
        down: false, downT: 0, marks: [],
        hostage: false,
      };
    };
    S.targets = [];
    for (let i = 0; i < hCount; i++) {
      S.targets.push(mkTarget('hostile', pool[i % pool.length]));
    }
    let ci = hCount;
    for (let i = 0; i < cCount; i++) {
      if (situation === 'hostage' && i === 0) {
        // 인질: 첫 번째 적 바로 옆(0.45~0.75 m)에 밀착
        const anchor = pool[0];
        const side = Math.random() < 0.5 ? -1 : 1;
        const civ = mkTarget('civilian', anchor, side * (0.45 + Math.random() * 0.3));
        civ.hostage = true;
        S.targets.push(civ);
      } else {
        S.targets.push(mkTarget('civilian', pool[(ci++) % pool.length]));
      }
    }

    /* 대표(중앙값) 거리 갱신 — 레이저 폴백/지면 기울기 기준 */
    const hd = S.targets.filter(t => t.type === 'hostile').map(t => t.dist).sort((a, b) => a - b);
    S.mission.distanceM = hd[Math.floor(hd.length / 2)] || map.anchors[0].dist;

    /* 카메라(조준) 한계용: 표적 각도 범위 */
    S.tgtBox = {
      yawMin: Math.min(...S.targets.map(t => t.yawC)),
      yawMax: Math.max(...S.targets.map(t => t.yawC)),
      pitMin: Math.min(...S.targets.map(t => t.pitFeet)),
      pitMax: Math.max(...S.targets.map(t => t.centerPit + 1)),
    };

    S.magazine = S.shotsPerRound;
    S.roundShots = [];
    S.activeShot = null;
    S.ending = false;
    S._dopeHint = null;
    setMsg(`라운드 ${S.roundIdx + 1}/${S.roundsTotal} — 적 ${hCount}` +
      (cCount ? ` · 민간인 ${cCount} (사격 금지!)` : '') +
      (S.roundIdx === 0 && situation !== 'none' ? ` · ${SITUATION_TEXT[situation].split(' — ')[0]}` : ''), 5);
  }
  function backToMenu() {
    S.phase = 'menu';
    document.exitPointerLock && document.exitPointerLock();
    $('game').classList.add('hidden');
    $('analysis').classList.add('hidden');
    $('result').classList.add('hidden');
    $('menu').classList.remove('hidden');
    updateTouchBar();
    showStep('mission');
  }
  function setMsg(text, dur = 3) { S.msg = text; S.msgUntil = now() + dur; }

  /* ---------------- 발사 / 판정 ---------------- */
  // 인체 존 판정 (dy: 인체 중심(지상 0.9 m) 기준 상방 [m], dz: 우측 [m])
  function zoneHit(dy, dz) {
    if (Math.hypot(dz, dy - 0.76) <= 0.13) return { zone: '머리', score: 10 };
    if (dy > 0.18 && dy <= 0.64 && Math.abs(dz) <= 0.19) return { zone: '흉부', score: 9 };
    if (dy > -0.12 && dy <= 0.18 && Math.abs(dz) <= 0.17) return { zone: '복부', score: 7 };
    if (dy > -0.90 && dy <= -0.12 && Math.abs(dz) <= 0.16) return { zone: '하지', score: 5 };
    if (dy > 0.05 && dy <= 0.60 && Math.abs(dz) <= 0.30) return { zone: '팔', score: 4 };
    return null;
  }
  // 수평거리 dh 지점의 지면 높이 [m]
  function gYat(dh) {
    const g = geom();
    return lerp(-1.6, g.ty - 0.9, clamp(dh / g.Dh, 0, 1.15));
  }

  function fire() {
    const t = now();
    if (t < S.canFireAt || S.activeShot || S.ending) return;
    if (S.magazine <= 0) { playDry(); return; }

    S.magazine--;
    S.firedTotal++;
    S.canFireAt = t + (S.rifle.id === 'm107a1' ? 0.6 : 1.5);
    playShot();
    playBolt(S.rifle.id === 'm107a1');

    const g = geom();
    const mv = S.ammo.mv + gauss() * S.ammo.mvSd;
    const disp = 0.145e-3; // ~0.5 MOA 고유 산포
    const elevRad = g.incl + S.zeroAngle
      + (S.aim.pitch + S.sway.pitch + S.recoil.pitch) * 1e-3
      + S.dial.elev * 0.1e-3
      + gauss() * disp;
    const azRad = (S.aim.yaw + S.sway.yaw + S.recoil.yaw) * 1e-3
      + S.dial.wind * 0.1e-3
      + gauss() * disp;

    const env = { ...S.mission.env, windSpeed: S.windNow, windFromDeg: S.windDirNow, coriolis: true };
    const maxDh = Math.max(g.Dh, ...S.targets.map(tg => tg.dh)) + 25;
    const r = Ballistics.solveAtRange(ammoParams(mv), env,
      { elevRad, azRad }, maxDh, { dt: 0.003, recordPath: true });

    // 반동은 탄 비행이 끝난 뒤에 적용 — 비행 중 스코프는 고정되어 궤적을 볼 수 있다
    const kick = {
      pitch: S.rifle.recoilMrad * (0.7 + Math.random() * 0.5),
      yaw: S.rifle.recoilMrad * 0.25 * (Math.random() - 0.4),
    };

    if (!r || !r.path || r.path.length < 2) {
      S.recoil.pitch += kick.pitch;
      S.recoil.yaw += kick.yaw;
      S.shakeT = t + 0.18;
      S.shots.push({ hit: false });
      S.roundShots.push('miss');
      setMsg('탄이 표적까지 도달하지 못했다 (탄속 소진)', 3);
      if (S.magazine === 0) endRound(false, '탄환 소진');
      return;
    }
    const path = r.path;
    const reach = path[path.length - 1].x;

    // 경로 보간 + 스핀 편류/지구 곡률 보정
    const sg = S.ammo.sgFactor ?? 1.9;
    const curv = !!env.earthCurvature;
    const atX = xq => {
      let lo = 0, hi = path.length - 1;
      if (xq >= path[hi].x) lo = hi - 1;
      else while (hi - lo > 1) { const mid = (lo + hi) >> 1; (path[mid].x <= xq) ? lo = mid : hi = mid; }
      const a = path[lo], b = path[lo + 1] || a;
      const f = b.x > a.x ? clamp((xq - a.x) / (b.x - a.x), 0, 1) : 0;
      const tt = lerp(a.t, b.t, f);
      const spin = 1.25 * (sg + 1.2) * Math.pow(Math.max(tt, 0), 1.83) * 0.0254;
      return {
        y: lerp(a.y, b.y, f) + (curv ? xq * xq / (2 * 6.371e6) : 0),
        z: lerp(a.z, b.z, f) + spin,
        t: tt, v: lerp(a.v, b.v, f),
      };
    };

    // 가까운 표적부터 피격 판정 (첫 명중에서 탄 정지)
    let hitIdx = -1, hitZone = null, hitAt = null;
    const order = S.targets.map((tg, i) => i)
      .filter(i => !S.targets[i].down && S.targets[i].dh <= reach)
      .sort((a, b) => (S.targets[a].dh - S.targets[b].dh) ||
        ((S.targets[a].type === 'civilian' ? 0 : 1) - (S.targets[b].type === 'civilian' ? 0 : 1)));
    for (const i of order) {
      const tg = S.targets[i];
      const p = atX(tg.dh);
      const dy = p.y - tg.cY, dz = p.z - tg.z;
      const zh = zoneHit(dy, dz);
      if (zh) { hitIdx = i; hitZone = zh; hitAt = { ...p, dy, dz }; break; }
    }

    // 빗나감이면 각도상 최근접 생존 표적 기준 오차 계산
    let missInfo = null;
    if (hitIdx < 0) {
      let bd = 1e9;
      for (const tg of S.targets) {
        if (tg.down || tg.dh > reach) continue;
        const p = atX(tg.dh);
        const dy = p.y - tg.cY, dz = p.z - tg.z;
        const dist = Math.hypot(dy, dz);
        if (dist < bd) { bd = dist; missInfo = { dy, dz, dh: tg.dh, p }; }
      }
    }
    const endP = atX(Math.min(g.Dh, reach));
    const tof = hitIdx >= 0 ? hitAt.t : endP.t;
    S.activeShot = {
      t0: t, path, tof, kick,
      // 비행 중 스코프 고정용: 격발 순간의 카메라
      cam: {
        yaw: S.aim.yaw + S.sway.yaw + S.recoil.yaw,
        pitch: S.aim.pitch + S.sway.pitch + S.recoil.pitch,
      },
      result: { hitIdx, hitZone, hitAt, missInfo, tof, vImp: hitIdx >= 0 ? hitAt.v : endP.v },
    };
  }

  function resolveShot() {
    const a = S.activeShot; if (!a) return;
    S.activeShot = null;
    // 착탄 확인 후 반동/노리쇠 사이클 반영
    S.recoil.pitch += a.kick.pitch;
    S.recoil.yaw += a.kick.yaw;
    S.shakeT = now() + 0.14;
    const res = a.result;
    const g = geom();
    if (res.hitIdx >= 0) {
      const tg = S.targets[res.hitIdx];
      tg.down = true; tg.downT = now();
      tg.marks.push({ dy: res.hitAt.dy, dz: res.hitAt.dz });
      if (tg.type === 'civilian') {
        playThud(tg.dh / 343);
        S.bigMsg = { text: tg.hostage ? '인질 피격' : '민간인 피격', color: '#e05c4a', until: now() + 2.2 };
        S.shots.push({ hit: true, civilian: true });
        S.roundShots.push('civ');
        endRound(false, tg.hostage ? '인질 피격' : '민간인 피격 — 교전 수칙 위반');
        return;
      }
      playDing(tg.dh / 343);
      const bonus = res.hitZone.zone === '머리' ? 2 : 0;
      S.bigMsg = { text: bonus ? '헤드샷' : '명중', color: '#8fd14f', until: now() + 1.6 };
      const pts = res.hitZone.score + bonus + (S.firedTotal === 1 ? 5 : 0);
      S.score += pts;
      S.shots.push({ hit: true, zone: res.hitZone.zone });
      S.roundShots.push('hit');
      const remain = S.targets.filter(x => x.type === 'hostile' && !x.down).length;
      setMsg(`${res.hitZone.zone} 명중! +${pts}점${bonus ? ' (헤드샷)' : ''}` +
        ` · 비행 ${fmt(res.tof, 2)}s · 착탄속도 ${fmt(res.vImp, 0)} m/s · 잔여 적 ${remain}`, 4.5);
      if (remain === 0) { endRound(true); return; }
      if (S.magazine === 0) endRound(false, '탄환 소진 — 적 잔존');
    } else {
      playThud(S.mission.distanceM / 343);
      S.bigMsg = { text: '빗나감', color: '#e0a03c', until: now() + 1.4 };
      S.shots.push({ hit: false });
      S.roundShots.push('miss');
      const mi = res.missInfo;
      if (mi) {
        const dirV = mi.dy > 0 ? '위' : '아래';
        const dirH = mi.dz > 0 ? '오른쪽' : '왼쪽';
        setMsg(`빗나감 — 최근접 표적 기준 ${dirV} ${fmt(Math.abs(mi.dy), 2)} m · ` +
          `${dirH} ${fmt(Math.abs(mi.dz), 2)} m`, 4);
        S.puffs.push({
          yawMrad: Math.atan2(mi.p.z, mi.dh) * 1000,
          pitchMrad: (Math.atan2(mi.p.y, mi.dh) - g.incl) * 1000,
          t0: now(),
        });
      } else setMsg('빗나감', 3);
      if (S.magazine === 0) endRound(false, '탄환 소진');
    }
  }

  /* ---------------- 라운드 종료 / 임무 결과 ---------------- */
  // 탄환 소진·민간인 피격 = 라운드 실패, 적 전원 제압 = 라운드 성공.
  function endRound(success, reason) {
    if (S.ending) return;
    S.ending = true;
    S.roundResults[S.roundIdx] = success ? 'success' : 'fail';
    setTimeout(() => {
      S.bigMsg = {
        text: success ? `라운드 ${S.roundIdx + 1} 성공` : `라운드 ${S.roundIdx + 1} 실패`,
        color: success ? '#8fd14f' : '#9aa59c',
        until: now() + 1.8,
      };
      if (reason) setMsg(`라운드 ${S.roundIdx + 1} ${success ? '성공' : '실패'} — ${reason}`, 3.5);
    }, 500);
    setTimeout(() => {
      S.roundIdx++;
      if (S.roundIdx >= S.roundsTotal) showResult();
      else spawnRound();
    }, 2400);
  }
  function showResult() {
    S.phase = 'result';
    document.exitPointerLock && document.exitPointerLock();
    const ok = S.roundResults.filter(r => r === 'success').length;
    const hits = S.shots.filter(x => x.hit && !x.civilian).length;
    const acc = S.firedTotal ? hits / S.firedTotal : 0;
    const heads = S.shots.filter(x => x.zone === '머리').length;
    const ratio = ok / S.roundsTotal;
    const pts = ratio * 60 + acc * 30 + Math.min(1, heads / S.roundsTotal) * 10;
    const grade = ok === 0 ? 'F' : pts >= 80 ? 'S' : pts >= 62 ? 'A' : pts >= 42 ? 'B' : 'C';
    const success = ok > 0;
    const dots = S.roundResults.map(r =>
      `<span class="rdot ${r}"></span>`).join('');
    $('result-title').textContent = ok === S.roundsTotal ? '임무 완수'
      : success ? '임무 종료' : '임무 실패';
    $('result-title').classList.toggle('fail', !success);
    $('result-grade').textContent = grade;
    $('result-grade').classList.toggle('fail', !success);
    $('result-stats').innerHTML = `<table>
      <tr><td>라운드 성공</td><td>${ok} / ${S.roundsTotal} <span class="rdots">${dots}</span></td></tr>
      <tr><td>발사 / 명중</td><td>${S.firedTotal}발 / ${hits}발 (${fmt(acc * 100, 0)}%)</td></tr>
      <tr><td>헤드샷</td><td>${heads}</td></tr>
      <tr><td>라운드당 탄환</td><td>${S.shotsPerRound}발</td></tr>
      <tr><td>총점</td><td>${S.score}</td></tr></table>`;
    $('result').classList.remove('hidden');
    updateTouchBar();
  }

  /* ---------------- 업데이트 ---------------- */
  let lastT = now();
  let lastHistPush = 0;
  function update() {
    const t = now();
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    if (S.phase !== 'play') return;

    const env = S.mission.env;
    const gust = env.gustiness || 0.2;

    // ── 바람: 장주기 드리프트 × 단주기 돌풍 — 사수 위치와 표적 지역을 분리 ──
    S.windNoiseT += dt;
    const T = S.windNoiseT;
    const slow = 1 + 0.45 * noise1(T * 0.035, 21);
    const drift = 28 * noise1(T * 0.022, 22) + 12 * gust * noise1(T * 0.35, 2);
    // 사수 위치 바람 (풍속계·바람 소리의 기준)
    S.windShooterNow = Math.max(0, (S.windSh?.base ?? env.windSpeed) * slow * (1 + gust * 0.6 * noise1(T * 0.6, 1)));
    S.windShooterDirNow = (S.windSh?.dir ?? env.windFromDeg) + drift;
    // 표적 지역 바람 (실제 탄도·표적 근처 깃발의 기준 — 국지풍 상황이면 다름)
    S.windNow = Math.max(0, (S.windTg?.base ?? env.windSpeed) * slow * (1 + gust * 0.6 * noise1(T * 0.6, 4)));
    S.windDirNow = (S.windTg?.dir ?? env.windFromDeg) + drift * 0.85 + 8 * gust * noise1(T * 0.4, 9);

    // 풍속계 표시값: '사수 위치' 바람 + 1초 시정수 스무딩 + 관측 오차
    const e = S.mission.spotterErr;
    const k = 1 - Math.exp(-dt / 0.8);
    S.windMeas += (S.windShooterNow * (1 + e * S.spotterNoise.wind * 0.4) - S.windMeas) * k;
    S.windDirMeas += (S.windShooterDirNow + e * 15 * S.spotterNoise.dir - S.windDirMeas) * k;
    if (t - lastHistPush > 0.25) {
      lastHistPush = t;
      S.windHist.push({ t, v: S.windMeas });
      while (S.windHist.length && t - S.windHist[0].t > 45) S.windHist.shift();
    }

    // ── 호흡 / 심박 ──
    S.breathPhase += dt * (TAU / 4.2);
    S.heartPhase += dt * (S.heartRate / 60) * TAU;
    if (S.holdingBreath && S.o2 > 0 && S.recovering <= 0) {
      S.o2 = Math.max(0, S.o2 - dt * 14);
      if (S.o2 === 0) {
        S.recovering = 4; S.heartRate = 105;
        if (S.fireHold) { // 숨을 더 못 참으면 숨참기 자동 해제
          S.fireHold = false;
          const b = $('btn-breath'); if (b) b.classList.remove('on');
          const p = $('p-breath'); if (p) p.classList.remove('on');
          setMsg('숨이 찼다 — 호흡 회복 중', 2);
        }
      }
    } else {
      S.o2 = Math.min(100, S.o2 + dt * (S.recovering > 0 ? 10 : 25));
    }
    if (S.recovering > 0) S.recovering = Math.max(0, S.recovering - dt);
    S.heartRate = Math.max(70, S.heartRate - dt * 6);

    const holdEff = (S.holdingBreath && S.o2 > 0 && S.recovering <= 0) ? 0.15 : 1;
    const recovEff = S.recovering > 0 ? 2.2 : 1;
    const amp = 0.5 * S.rifle.swayFactor * holdEff * recovEff;
    const beat = Math.pow(Math.max(0, Math.sin(S.heartPhase)), 12) * 0.1667 * (S.heartRate / 70);
    S.sway.pitch = amp * (Math.sin(S.breathPhase) * 0.8 + noise1(t * 0.9, 5) * 0.4) + beat * recovEff;
    S.sway.yaw = amp * (noise1(t * 0.7, 9) * 0.55) + beat * 0.3;

    // 반동 복원
    const rd = Math.exp(-dt * 2.8);
    S.recoil.pitch *= rd;
    S.recoil.yaw *= rd;

    // 조준을 배경 한계 안으로 — 가장자리에서 더 드래그해도 배경(표적/깃발)이 밀리지 않는다
    clampAim();

    if (S.activeShot && t - S.activeShot.t0 >= S.activeShot.tof) resolveShot();

    if (t - S.lastHudUpdate > 0.15) { S.lastHudUpdate = t; updateHud(); }
    drawWindMeter();
    updateWindAmbience();
  }

  /* ---------------- 풍향풍속계 위젯 ---------------- */
  function drawWindMeter() {
    drawWindRose(windCx, windCv.width, windCv.height);
    const mw = $('m-wind');
    if (mw && !$('ctl-panel').classList.contains('hidden')) {
      drawWindRose(mw.getContext('2d'), mw.width, mw.height);
    }
    drawWindHistory();
  }
  function drawWindRose(c, Wc, Hc) {
    const cx = Wc / 2, cy = Hc / 2, R = Wc / 2 - 10;
    c.clearRect(0, 0, Wc, Hc);
    if (S.phase !== 'play') return;
    const fireAz = S.mission.env.fireAzimuthDeg;
    // 로즈: 12시 = 사격 방향
    c.strokeStyle = '#33463a'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
    c.strokeStyle = '#26362c';
    c.beginPath(); c.arc(cx, cy, R * 0.62, 0, TAU); c.stroke();
    c.fillStyle = '#7d9484'; c.font = '10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 30) {
      const rad = (a - 90) * Math.PI / 180;
      const x1 = cx + Math.cos(rad) * (R - 4), y1 = cy + Math.sin(rad) * (R - 4);
      const x2 = cx + Math.cos(rad) * R, y2 = cy + Math.sin(rad) * R;
      c.strokeStyle = '#4b6252';
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    // 표적 방향 마커 (12시)
    c.fillStyle = '#8fd14f';
    c.beginPath(); c.moveTo(cx, cy - R - 6); c.lineTo(cx - 5, cy - R + 4); c.lineTo(cx + 5, cy - R + 4); c.closePath(); c.fill();
    c.fillStyle = '#5f7566'; c.font = '9px sans-serif';
    c.fillText('표적', cx, cy - R + 13);
    // 북쪽 표시
    const northA = (-fireAz - 90) * Math.PI / 180;
    c.fillStyle = '#b46a55';
    c.fillText('N', cx + Math.cos(northA) * (R - 13), cy + Math.sin(northA) * (R - 13));
    // 바람 화살표: 바람이 "불어가는" 방향 (사수 기준)
    const rel = (S.windDirMeas - fireAz + 180) * Math.PI / 180; // to-direction
    const a0 = rel - Math.PI / 2;
    const spd = clamp(S.windMeas / 12, 0.12, 1);
    const len = R * 0.78 * (0.45 + 0.55 * spd);
    c.save();
    c.translate(cx, cy); c.rotate(a0 + Math.PI / 2);
    c.strokeStyle = '#e0a03c'; c.fillStyle = '#e0a03c'; c.lineWidth = 3; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, len * 0.45); c.lineTo(0, -len * 0.55); c.stroke();
    c.beginPath(); c.moveTo(0, -len * 0.55 - 8); c.lineTo(-7, -len * 0.55 + 6); c.lineTo(7, -len * 0.55 + 6); c.closePath(); c.fill();
    c.restore();
    // 중앙 속도
    c.fillStyle = '#0c120e';
    c.beginPath(); c.arc(cx, cy, 24, 0, TAU); c.fill();
    c.strokeStyle = '#33463a'; c.beginPath(); c.arc(cx, cy, 24, 0, TAU); c.stroke();
    c.fillStyle = '#eaf6ec'; c.font = '700 15px monospace';
    c.fillText(S.windMeas.toFixed(1), cx, cy - 4);
    c.fillStyle = '#7d9484'; c.font = '9px sans-serif';
    c.fillText('m/s', cx, cy + 10);
  }
  function drawWindHistory() {
    if (S.phase !== 'play') return;
    const fireAz = S.mission.env.fireAzimuthDeg;
    // 디지털 표시
    const relDeg = ((S.windDirMeas - fireAz) % 360 + 360) % 360;
    const clock = Math.round(relDeg / 30) % 12 || 12;
    $('wind-digital').innerHTML =
      `${S.windMeas.toFixed(1)} <span class="dim">m/s</span> · ${Math.round(((S.windDirMeas % 360) + 360) % 360)}°` +
      ` <span class="dim">(${clock}시 방향에서)</span>`;

    // 히스토리 스파크라인 (최근 45초)
    const h = histCx, Wh = histCv.width, Hh = histCv.height;
    h.clearRect(0, 0, Wh, Hh);
    if (S.windHist.length > 1) {
      const t = now();
      const vmax = Math.max(2, ...S.windHist.map(p => p.v)) * 1.15;
      h.strokeStyle = '#4fb7d1'; h.lineWidth = 1.4;
      h.beginPath();
      S.windHist.forEach((p, i) => {
        const x = Wh - (t - p.t) / 45 * Wh;
        const y = Hh - 3 - (p.v / vmax) * (Hh - 8);
        i ? h.lineTo(x, y) : h.moveTo(x, y);
      });
      h.stroke();
      h.fillStyle = '#5f7566'; h.font = '8px sans-serif'; h.textAlign = 'left';
      h.fillText('풍속 45s', 3, 9);
    }
  }

  /* ---------------- HUD ---------------- */
  /* 라운드 탄환 표시: 발사한 슬롯은 명중(녹)/빗나감(적)/민간인(보라), 남은 탄은 밝게 */
  function ammoDotsHtml() {
    let h = '';
    for (let i = 0; i < S.shotsPerRound; i++) {
      const r = S.roundShots[i];
      h += `<span class="blt ${r || 'live'}">●</span>`;
    }
    return h;
  }
  function updateHud() {
    const m = S.mission, env = m.env;

    const hostRemain = S.targets.filter(x => x.type === 'hostile' && !x.down).length;
    const civCount = S.targets.filter(x => x.type === 'civilian' && !x.down).length;
    const at = aimedTarget();
    const laser = at
      ? `<b>${at.dist.toLocaleString()} m</b> <span class="warn">◆ 표적 조준</span>`
      : `<b>${m.distanceM.toLocaleString()} m</b> <span style="font-size:10px">(대표)</span>`;
    const sitText = SITUATION_TEXT[m.situation] || '';
    $('hud-mission').innerHTML =
      `<h4>임무</h4><b>${m.name}</b><br>` +
      (sitText ? `<span class="${m.situation === 'hostage' ? 'bad' : 'warn'}" style="font-size:11.5px">${sitText}</span><br>` : '') +
      `<span style="color:var(--dim);font-size:11.5px">` +
      `거리(레이저) ${laser}<br>` +
      `기온 ${fmt(env.tempC, 0)}℃ · 습도 ${fmt(env.rhPct, 0)}% · 고도 ${env.altitudeM.toLocaleString()} m<br>` +
      `기압 ${fmt(Ballistics.pressureAtAltitude(env.altitudeM), 0)} hPa · 위도 ${fmt(env.latitudeDeg, 1)}° · 방위 ${fmt(env.fireAzimuthDeg, 0)}°` +
      (env.earthCurvature ? ' · <span class="warn">곡률 유효</span>' : '') +
      `</span><br>` +
      `<span class="warn" style="font-size:14px;font-weight:700">라운드 ${Math.min(S.roundIdx + 1, S.roundsTotal)}/${S.roundsTotal}</span> · ` +
      `탄환 ${ammoDotsHtml()} · 적 <b>${hostRemain}</b> 남음` +
      (civCount ? ` · <span class="bad">민간인 ${civCount} — 사격 금지</span>` : '') +
      `<br><span class="warn">점수 ${S.score}</span> · 발사 ${S.firedTotal} · 명중 ${S.shots.filter(x => x.hit && !x.civilian).length}`;
    // 탄도표 강조 행을 조준 중 표적 거리로 (하이라이트 토글 반영)
    const hint = S.assistHL ? (at ? at.dist : m.distanceM) : -1;
    if (S._dopeHint !== hint) { S._dopeHint = hint; renderBallistic(at ? at.dist : m.distanceM); }

    $('hud-weapon').innerHTML =
      `<h4>화기 / 선택 탄종</h4><b>${S.rifle.name}</b><br>` +
      `${S.ammo.name}<br>` +
      `<span style="color:var(--dim);font-size:11.5px">BC(${S.ammo.dragModel}) ${S.ammo.bc} · V₀ ${fmt(S.ammo.mv, 0)} m/s · ${S.ammo.bulletGr} gr · ${reticleName()}</span><br>` +
      `탄환 ${ammoDotsHtml()} <b>${S.magazine}</b>/${S.shotsPerRound}` +
      ` · 배율 ${fmt(S.mag, 0)}×`;

    const o2Cls = S.o2 < 30 ? 'bad' : '';
    $('hud-body').innerHTML =
      `<h4>터렛 / 신체</h4>` +
      `엘리베이션 <b>${fmt(S.dial.elev * 0.1, 1)} mil</b> (↑↓) · ` +
      `윈디지 <b>${fmt(S.dial.wind * 0.1, 1)} mil</b> (←→)<br>` +
      `산소 <span class="meter o2"><i style="width:${S.o2}%"></i></span> <span class="${o2Cls}">${fmt(S.o2, 0)}%</span> · ` +
      `심박 <span class="meter hr"><i style="width:${clamp((S.heartRate - 50) / 80 * 100, 0, 100)}%"></i></span> ${fmt(S.heartRate, 0)}` +
      (S.recovering > 0 ? '<br><span class="bad">호흡 회복 중 — 조준 불안정!</span>' : '');

    // 모바일 상단 정보바
    if (!$('mobile-top').classList.contains('hidden')) {
      $('mt-info').textContent =
        `R${Math.min(S.roundIdx + 1, S.roundsTotal)}/${S.roundsTotal} · 탄 ${S.magazine}/${S.shotsPerRound}` +
        ` · 적 ${hostRemain}` + (civCount ? ` · 민간인 ${civCount}` : '') +
        ` · ${S.score}점` +
        (m.situation && m.situation !== 'none' ? ` · ${SITUATION_TEXT[m.situation].split(' — ')[0]}` : '');
    }
    // 컨트롤 패널 수치
    if (!$('ctl-panel').classList.contains('hidden')) {
      $('p-vitals').innerHTML = `♥ ${Math.round(S.heartRate)} <small>BPM</small>`;
      $('p-o2fill').style.width = `${S.o2}%`;
      // 조작 탭 상태줄: 라운드·탄환 + 현재 고각/윈디지/배율 (읽기 전용)
      $('cp-status').innerHTML =
        `R<b>${Math.min(S.roundIdx + 1, S.roundsTotal)}/${S.roundsTotal}</b> · ` +
        `탄환 ${ammoDotsHtml()} · ` +
        `고각 <b>${fmt(S.dial.elev * 0.1, 1)}</b> · ` +
        `윈디지 <b>${fmt(S.dial.wind * 0.1, 1)}</b> mil · ` +
        `<b>${S.mag}×</b>`;
      if (S.windHist.length) {
        const vs = S.windHist.map(p => p.v);
        const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
        $('p-windtxt').innerHTML =
          `CUR <b>${S.windMeas.toFixed(1)}</b> ㎧ · ${Math.round(((S.windDirMeas % 360) + 360) % 360)}°<br>` +
          `AVG ${avg.toFixed(1)} · MAX ${Math.max(...vs).toFixed(1)}`;
      }
    }

    $('hud-log').textContent = now() < S.msgUntil ? S.msg : '';
  }

  /* ---------------- 렌더링 ---------------- */
  // 논리 해상도 고정(1440×900) — 모든 기기에서 같은 화면 비율.
  const BASE_W = 1440, BASE_H = 900;
  function resize() {
    canvas.width = BASE_W;
    canvas.height = BASE_H;
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    let sc;
    const st = $('stage');
    $('game').classList.toggle('mobile-sq', !!(coarse && portrait));
    if (coarse && portrait) {
      // 모바일 세로: 상단바(34) + 스코프(정사각, 좌우 크롭) + 컨트롤 패널 + 내비(56)
      const TOPBAR = 34, NAV = 56;
      const panelH = clamp(Math.round(window.innerHeight * 0.34), 232, 400);
      const side = Math.min(window.innerWidth,
        window.innerHeight - TOPBAR - NAV - panelH);
      sc = side / BASE_H;
      if (st) {
        st.style.transform = `translate(-50%, -50%) scale(${sc})`;
        st.style.top = `${TOPBAR + (BASE_H * sc) / 2}px`;
      }
      const cp = $('ctl-panel');
      if (cp) {
        cp.style.top = `${TOPBAR + side}px`;
        cp.style.bottom = `${NAV}px`;
      }
    } else {
      sc = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
      if (st) {
        st.style.transform = `translate(-50%, -50%) scale(${sc})`;
        st.style.top = portrait ? `${(BASE_H * sc) / 2 + 6}px` : '50%';
      }
    }
    S.stageScale = sc;
    retLayers.clear();   // 두께가 stageScale에 연동되므로 레티클 레이어를 다시 굽는다
  }
  window.addEventListener('resize', resize);
  resize();

  const TERRAIN = {
    plains:  { skyTop: '#7fb4d9', skyBot: '#cfe3ea', ground: ['#8aa35f', '#5d7a45', '#41582f'], haze: '#c9d4bd', ridge: '#5f7568', features: ['pines'] },
    forest:  { skyTop: '#86b6d6', skyBot: '#d3e5e2', ground: ['#97a468', '#6a7a4b', '#4a5a34'], haze: '#cfd8c0', ridge: '#3d5240', features: ['berm', 'pines'] },
    farm:    { skyTop: '#8cbede', skyBot: '#dcebe8', ground: ['#a4b06a', '#79854d', '#565f38'], haze: '#d7ddc2', ridge: '#5c7258', features: ['barn', 'pines'] },
    mountain:{ skyTop: '#6e9fc9', skyBot: '#d7e4ec', ground: ['#9aa38e', '#6b7a62', '#4a5844'], haze: '#c2cdc4', ridge: '#697a86', features: ['peaks'] },
    desert:  { skyTop: '#96b6d0', skyBot: '#e8d9b8', ground: ['#d9c08a', '#b89e66', '#93794a'], haze: '#e3d3ad', ridge: '#a98f63', features: ['dunes'] },
    kasbah:  { skyTop: '#9db4c4', skyBot: '#e8d4ae', ground: ['#c9a978', '#a8865a', '#83683f'], haze: '#e0cfa6', ridge: '#96774f', features: ['dunes'] },
    tundra:  { skyTop: '#8ba7bd', skyBot: '#d5dde3', ground: ['#c3cbc0', '#98a396', '#75816f'], haze: '#d3dad6', ridge: '#8b9aa4', features: ['peaks'] },
  };

  function parseColor(c) {
    if (c[0] === '#') {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    return c.match(/\d+/g).slice(0, 3).map(Number);
  }
  function mixColor(c1, c2, f) {
    const a = parseColor(c1), b = parseColor(c2);
    const m = a.map((v, i) => Math.round(lerp(v, b[i], f)));
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ================================================================
   * 렌더링: 이중 패스
   *  패스 1 — 스코프 밖: 1× 육안 배율 주변시 (저해상 + 블러)
   *  패스 2 — 스코프 안: 현재 배율로 확대, 선명
   * ================================================================ */

  /* 세계 렌더링 (임의 컨텍스트/배율) */
  function renderWorld(tctx, Wv, Hv, ppmW, camYaw, camPitch, opts = {}) {
    const prevCtx = ctx; ctx = tctx;
    const t = now();
    const g = geom();
    const m = S.mission;
    const ter = TERRAIN[m.terrain] || TERRAIN.plains;
    const cx = Wv / 2, cy = Hv / 2;
    const sx = yawMrad => cx + (yawMrad - camYaw) * ppmW;
    const sy = pitchMrad => cy - (pitchMrad - camPitch) * ppmW;
    const relPitch = absRad => (absRad - g.incl) * 1000;
    const groundYat = r => lerp(-1.6, g.ty - 0.9, clamp(r / g.Dh, 0, 1.15));
    const groundPitchAt = r => relPitch(Math.atan2(groundYat(r), r));

    /* ===== 배경: 사진 or 절차적 =====
     * 사진은 카메라 각도에 1:1 고정 — 가장자리에서 절대 clamp로 밀리지
     * 않는다 (표적/깃발 위치 고정의 핵심). 사진 밖 노출부는 가장자리
     * 1px을 늘린 스미어로 채워 자연스럽게 이어 붙인다. */
    const bg = BG[m.terrain];
    if (bg && bg.img) {
      const img = bg.img;
      const meta = BG_META[m.terrain] || BG_META._default;
      const pxm = img.width / meta.mradW;
      const scl = ppmW / pxm; // 사진 px → 화면 px
      const sw = (Wv / ppmW) * pxm;
      const sh = (Hv / ppmW) * pxm;
      const sx0 = img.width * (meta.xFrac ?? 0.5) + camYaw * pxm - sw / 2;
      const sy0 = img.height * meta.cFrac - camPitch * pxm - sh / 2;
      // 사진과 뷰의 교집합 (사진 좌표)
      const ix0 = Math.max(0, sx0), iy0 = Math.max(0, sy0);
      const ix1 = Math.min(img.width, sx0 + sw), iy1 = Math.min(img.height, sy0 + sh);
      if (ix1 > ix0 && iy1 > iy0) {
        const dx0 = (ix0 - sx0) * scl, dy0 = (iy0 - sy0) * scl;
        const dx1 = (ix1 - sx0) * scl, dy1 = (iy1 - sy0) * scl;
        // 가장자리 스미어 (좌/우/상/하 + 모서리)
        if (dx0 > 0.5) ctx.drawImage(img, ix0, iy0, 1, iy1 - iy0, 0, dy0, dx0 + 1, dy1 - dy0);
        if (dx1 < Wv - 0.5) ctx.drawImage(img, ix1 - 1, iy0, 1, iy1 - iy0, dx1 - 1, dy0, Wv - dx1 + 1, dy1 - dy0);
        if (dy0 > 0.5) ctx.drawImage(img, ix0, iy0, ix1 - ix0, 1, dx0, 0, dx1 - dx0, dy0 + 1);
        if (dy1 < Hv - 0.5) ctx.drawImage(img, ix0, iy1 - 1, ix1 - ix0, 1, dx0, dy1 - 1, dx1 - dx0, Hv - dy1 + 1);
        if (dx0 > 0.5 && dy0 > 0.5) ctx.drawImage(img, ix0, iy0, 1, 1, 0, 0, dx0 + 1, dy0 + 1);
        if (dx1 < Wv - 0.5 && dy0 > 0.5) ctx.drawImage(img, ix1 - 1, iy0, 1, 1, dx1 - 1, 0, Wv - dx1 + 1, dy0 + 1);
        if (dx0 > 0.5 && dy1 < Hv - 0.5) ctx.drawImage(img, ix0, iy1 - 1, 1, 1, 0, dy1 - 1, dx0 + 1, Hv - dy1 + 1);
        if (dx1 < Wv - 0.5 && dy1 < Hv - 0.5) ctx.drawImage(img, ix1 - 1, iy1 - 1, 1, 1, dx1 - 1, dy1 - 1, Wv - dx1 + 1, Hv - dy1 + 1);
        // 본 사진
        ctx.drawImage(img, ix0, iy0, ix1 - ix0, iy1 - iy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
      } else {
        drawProceduralScene(); // 뷰가 사진을 완전히 벗어난 극단 상황 폴백
      }
    } else {
      drawProceduralScene();
    }

    function drawProceduralScene() {
      const skyGrad = ctx.createLinearGradient(0, 0, 0, Hv);
      skyGrad.addColorStop(0, ter.skyTop);
      skyGrad.addColorStop(1, ter.skyBot);
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, Wv, Hv);

      /* 구름 (바람 따라 흐름) */
      const drift = t * (0.15 + S.windNow * 0.04);
      for (let i = 0; i < 7; i++) {
        const yawC = ((hash(S.sceneSeed + i) * 400 - 200) - drift + 200) % 400 - 200;
        const pitC = relPitch(0) + 22 + hash(S.sceneSeed + i * 3 + 1) * 60;
        const xw = (14 + hash(i + 9) * 26) * ppmW * 0.15;
        const x = sx(yawC), y = sy(pitC);
        if (x < -300 || x > Wv + 300) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.ellipse(x, y, xw * 2.6, xw * 0.7, 0, 0, TAU);
        ctx.ellipse(x + xw, y - xw * 0.35, xw * 1.6, xw * 0.55, 0, 0, TAU);
        ctx.fill();
      }

      /* 원경 능선 */
      const peaks = ter.features.includes('peaks');
      for (let layer = 0; layer < 2; layer++) {
        const hScale = peaks ? (layer ? 9 : 16) : (layer ? 3 : 5.5);
        ctx.fillStyle = mixColor(ter.ridge, ter.haze, layer ? 0.25 : 0.55);
        ctx.beginPath();
        ctx.moveTo(0, Hv);
        for (let px = 0; px <= Wv; px += 8) {
          const yawM = camYaw + (px - cx) / ppmW;
          const hM = Math.max(0.4,
            hScale * 0.55 + hScale * 0.45 * noise1(yawM * 0.011, 3 + layer * 4) +
            hScale * 0.3 * noise1(yawM * 0.037, 7 + layer));
          ctx.lineTo(px, sy(relPitch(0) + hM));
        }
        ctx.lineTo(Wv, Hv);
        ctx.closePath();
        ctx.fill();
      }

      /* 지면 밴드 */
      let prevY = Hv + 50;
      for (let i = 0; i < 30; i++) {
        const r = 18 * Math.pow(1.215, i);
        const yPix = sy(groundPitchAt(r));
        const fade = clamp(r / (g.Dh * 1.4), 0, 1);
        const base = mixColor(ter.ground[0], ter.ground[2], fade * 0.7);
        const tone = 0.18 + 0.16 * noise1(i * 1.7, 4);
        ctx.fillStyle = mixColor(mixColor(base, ter.ground[1], tone), ter.haze, fade * 0.38);
        ctx.fillRect(0, yPix, Wv, Math.max(0, prevY - yPix) + 2);
        prevY = yPix;
      }
      ctx.fillStyle = mixColor(ter.ground[2], ter.haze, 0.85);
      const horizonY = sy(relPitch(0));
      const farY = sy(groundPitchAt(6000));
      if (farY > horizonY) ctx.fillRect(0, horizonY, Wv, farY - horizonY);

      /* 사구 */
      if (ter.features.includes('dunes')) {
        for (let d = 0; d < 3; d++) {
          const rD = g.Dh * (0.45 + d * 0.28);
          const baseP = groundPitchAt(rD);
          ctx.fillStyle = mixColor(ter.ground[1], ter.haze, 0.2 + d * 0.2);
          ctx.beginPath();
          ctx.moveTo(0, sy(baseP) + 20);
          for (let px = 0; px <= Wv; px += 10) {
            const yawM = camYaw + (px - cx) / ppmW;
            const hM = Math.max(0, 2.2 * noise1(yawM * 0.02 + d * 9, 15 + d));
            ctx.lineTo(px, sy(baseP + hM));
          }
          ctx.lineTo(Wv, sy(baseP) + 20);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* 흙벽 백스톱 */
      if (ter.features.includes('berm')) {
        const rB = g.Dh + 25;
        const baseA = relPitch(Math.atan2(groundYat(rB), rB));
        const topH = g.ty + 0.9 + 2.2;
        ctx.fillStyle = mixColor('#c9b189', ter.haze, 0.18);
        ctx.beginPath();
        const x0b = sx(-38), x1b = sx(38);
        ctx.moveTo(x0b, sy(baseA));
        for (let px = x0b; px <= x1b; px += 8) {
          const yawM = camYaw + (px - cx) / ppmW;
          const topA = relPitch(Math.atan2(topH + 0.5 * noise1(yawM * 0.35, 31), rB));
          ctx.lineTo(px, sy(topA));
        }
        ctx.lineTo(x1b, sy(baseA));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,115,80,0.5)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 10; i++) {
          const yawM = -34 + hash(i + 40) * 68;
          const x = sx(yawM);
          ctx.beginPath();
          ctx.moveTo(x, sy(relPitch(Math.atan2(topH * (0.4 + hash(i + 50) * 0.5), rB))));
          ctx.lineTo(x + 2, sy(baseA));
          ctx.stroke();
        }
      }

      /* 소나무 스카이라인 */
      if (ter.features.includes('pines')) {
        const rT = g.Dh * 1.12 + 40;
        const baseY = ter.features.includes('berm') ? g.ty + 0.9 + 2.2 : groundYat(rT);
        ctx.fillStyle = mixColor('#2e4630', ter.haze, 0.3);
        for (let i = 0; i < 40; i++) {
          const yawM = -70 + i * 3.6 + hash(S.sceneSeed + i) * 2.5;
          const x = sx(yawM);
          if (x < -40 || x > Wv + 40) continue;
          const hTree = 7 + hash(S.sceneSeed * 3 + i) * 6;
          const wTree = (2.2 + hash(i + 77) * 1.6);
          const yBase = sy(relPitch(Math.atan2(baseY, rT)));
          const yTop = sy(relPitch(Math.atan2(baseY + hTree, rT)));
          const wPx = Math.atan2(wTree, rT) * 1000 * ppmW;
          ctx.beginPath();
          ctx.moveTo(x, yTop);
          ctx.lineTo(x - wPx, yBase);
          ctx.lineTo(x + wPx, yBase);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* 헛간 */
      if (ter.features.includes('barn')) {
        const rBn = g.Dh * 0.92;
        const yawBn = -30;
        const baseA = r2 => relPitch(Math.atan2(groundYat(rBn) + r2, rBn));
        const wB = Math.atan2(6, rBn) * 1000 * ppmW;
        const x = sx(yawBn);
        const yB = sy(baseA(0)), yWall = sy(baseA(4.5)), yRoof = sy(baseA(7.5));
        ctx.fillStyle = mixColor('#8d3b2c', ter.haze, 0.15);
        ctx.fillRect(x - wB, yWall, wB * 2, yB - yWall);
        ctx.fillStyle = mixColor('#7d7466', ter.haze, 0.1);
        ctx.beginPath();
        ctx.moveTo(x - wB * 1.08, yWall);
        ctx.lineTo(x, yRoof);
        ctx.lineTo(x + wB * 1.08, yWall);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(90,60,40,0.6)'; ctx.lineWidth = 1;
        for (let i = 1; i < 7; i++) {
          const fx = x - wB + (2 * wB / 7) * i;
          ctx.beginPath(); ctx.moveTo(fx, yWall); ctx.lineTo(fx, yB); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(50,32,24,0.85)';
        ctx.fillRect(x - wB * 0.2, yWall + (yB - yWall) * 0.35, wB * 0.4, (yB - yWall) * 0.65);
      }
    }

    /* ===== 바람 깃발 ===== */
    const windPsi = (S.windDirNow - m.env.fireAzimuthDeg) * Math.PI / 180;
    const windZ = -Math.sin(windPsi) * S.windNow;
    const flagFracs = [0.55, 0.75, 0.95];
    for (let i = 0; i < flagFracs.length; i++) {
      const r = g.Dh * flagFracs[i];
      const zOff = (i % 2 ? 1 : -1) * r * 0.0045;
      const baseY = groundYat(r);
      const poleTopA = relPitch(Math.atan2(baseY + 2.6, r));
      const poleBotA = relPitch(Math.atan2(baseY, r));
      const yawA = Math.atan2(zOff, r) * 1000;
      const x = sx(yawA);
      if (x < -60 || x > Wv + 60) continue;
      ctx.strokeStyle = '#3a3f36';
      ctx.lineWidth = Math.max(1, ppmW * 0.02);
      ctx.beginPath(); ctx.moveTo(x, sy(poleBotA)); ctx.lineTo(x, sy(poleTopA)); ctx.stroke();
      const flagLen = clamp(Math.abs(windZ) / 8, 0.25, 1) * (0.9 / r) * 1000 * ppmW;
      const dir = windZ >= 0 ? 1 : -1;
      const flut = Math.sin(t * 6 + i) * 0.2 + 1;
      const fy = sy(poleTopA);
      ctx.fillStyle = '#d8402a';
      ctx.beginPath();
      ctx.moveTo(x, fy);
      ctx.lineTo(x + dir * flagLen * flut, fy + flagLen * 0.22 + Math.sin(t * 8 + i * 2) * 2);
      ctx.lineTo(x, fy + flagLen * 0.42);
      ctx.closePath(); ctx.fill();
    }

    /* ===== 인간형 표적지 — 사진 앵커(발 위치) 고정, 거리 비례 크기 =====
     * 적을 먼저, 민간인/인질을 나중에 그려 인질이 앞에 보이게 한다. */
    const drawOrder = [...S.targets].sort((a, b) =>
      (a.type === 'civilian' ? 1 : 0) - (b.type === 'civilian' ? 1 : 0));
    for (const tg of drawOrder) {
      const x = sx(tg.yawC), yFeet = sy(tg.pitFeet);
      if (x < -160 || x > Wv + 160) continue;
      const k = ppmW * 1000 / tg.dist; // px per meter @ 표적 거리
      drawTargetSheet(x, yFeet, k, tg, t);
    }

    /* ===== 착탄 먼지 ===== */
    const alive = [];
    for (const p of S.puffs) {
      const age = t - p.t0;
      if (age < 2.2) {
        alive.push(p);
        const px = sx(p.yawMrad), py = sy(p.pitchMrad);
        ctx.fillStyle = `rgba(150,130,100,${0.5 * (1 - age / 2.2)})`;
        ctx.beginPath();
        ctx.arc(px, py - age * 8, (4 + age * 14) * (ppmW > 10 ? 1 : 0.4), 0, TAU);
        ctx.fill();
      }
    }
    S.puffs = alive;

    /* ===== 탄도 궤적 트레이서 =====
     * 발사 후 스코프는 고정(격발 순간 카메라)되고, 탄이 낙하/편류하며
     * 멀어질수록 작아지는 모습과 꼬리 궤적이 보인다. */
    if (S.activeShot) {
      const a = S.activeShot;
      const ft = t - a.t0;
      const path = a.path;
      if (path && path.length > 1) {
        let idx = path.findIndex(pt => pt.t >= ft);
        if (idx < 0) idx = path.length - 1;
        idx = Math.max(1, idx);
        const scr = pt => ({
          x: sx(Math.atan2(pt.z, pt.x) * 1000),
          y: sy(relPitch(Math.atan2(pt.y, pt.x))),
        });
        // 꼬리: 최근 0.14초 구간을 점점 옅게
        ctx.save();
        ctx.lineCap = 'round';
        for (let j = idx; j > 1 && path[j - 1].t >= ft - 0.14 && path[j - 1].x > 3; j--) {
          const p1 = scr(path[j]), p0 = scr(path[j - 1]);
          const age = clamp((ft - path[j].t) / 0.14, 0, 1);
          ctx.strokeStyle = `rgba(255,235,170,${0.55 * (1 - age)})`;
          ctx.lineWidth = Math.max(1, 2.6 * (1 - age));
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
        ctx.restore();
        const pt = path[idx];
        if (pt.x > 3) {
          const b = scr(pt);
          // 거리에 반비례해 작아지는 탄
          const rad = clamp(ppmW * 24 / Math.max(pt.x, 12), 1.3, 8);
          ctx.fillStyle = 'rgba(255,240,190,0.95)';
          ctx.beginPath(); ctx.arc(b.x, b.y, rad, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,235,170,0.28)';
          ctx.beginPath(); ctx.arc(b.x, b.y, rad * 2.2, 0, TAU); ctx.fill();
        }
      }
    }

    /* ===== 아지랑이 ===== */
    if (opts.mirage) {
      const mirage = clamp((m.env.tempC - 15) / 30, 0, 1) * clamp(S.mag / 25, 0.3, 1);
      if (mirage > 0.05) {
        ctx.save();
        ctx.globalAlpha = mirage * 0.16;
        const hzY = sy(relPitch(0));
        for (let i = 0; i < 4; i++) {
          const yy = hzY + 30 + i * 42 + Math.sin(t * 2.4 + i) * 3;
          ctx.drawImage(ctx.canvas, 0, yy, Wv, 12, Math.sin(t * 3.5 + i * 1.8) * 3.5, yy, Wv, 12);
        }
        ctx.restore();
      }
    }

    ctx = prevCtx;
  }

  /* 사격장 인간형 표적지 (첨부 참조 스타일)
   *  적: 종이 표적지 위 검은 실루엣 + 흉부 링(7/8/9/10/X) + 헤드샷 존
   *  민간인/인질: 파란 실루엣 + 두 손 든 자세 (NO-SHOOT)
   *  x=발 위치 화면좌표, yFeet=발 y, k=px per meter. 시트 바닥 = 발 = 지면. */
  function drawTargetSheet(x, yFeet, k, tg, t) {
    const civ = tg.type === 'civilian';
    ctx.save();
    ctx.translate(x, yFeet);
    if (tg.down) {
      const age = t - (tg.downT || t);
      const fall = Math.min(1, age * 2.2);
      ctx.globalAlpha = 1 - 0.4 * fall;
      ctx.rotate((civ ? -1 : 1) * fall * Math.PI / 2 * 0.9); // 발(지면) 기준 뒤로 넘어감
    }
    const Y = m => -m * k; // 지면 기준 높이[m] → 화면 y

    // 지지 말뚝 + 종이 시트
    ctx.strokeStyle = '#5a4c38';
    ctx.lineWidth = Math.max(1, 0.04 * k);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, Y(1.86)); ctx.stroke();
    const shW = 0.72 * k;
    ctx.fillStyle = civ ? '#eef1f2' : '#e8e2d2';
    ctx.strokeStyle = 'rgba(60,55,45,0.7)';
    ctx.lineWidth = Math.max(0.8, 0.015 * k);
    ctx.fillRect(-shW / 2, Y(1.84), shW, 1.8 * k);
    ctx.strokeRect(-shW / 2, Y(1.84), shW, 1.8 * k);

    // ── 실루엣 (발 0.06 ~ 머리 1.80) ──
    const ink = civ ? '#4a7396' : '#141517';
    ctx.fillStyle = ink;
    ctx.beginPath();
    // 몸통·다리 윤곽 (대칭 폴리곤)
    const P = [ // [높이m, 반폭m] 아래→위
      [0.06, 0.09], [0.06, 0.17], [0.55, 0.16], [0.86, 0.19],
      [1.05, 0.21], [1.28, 0.30], [1.47, 0.31], [1.56, 0.15], [1.60, 0.085],
    ];
    ctx.moveTo(-P[0][1] * k, Y(P[0][0]));
    for (const [h, w] of P) ctx.lineTo(-w * k, Y(h));
    for (let i = P.length - 1; i >= 0; i--) ctx.lineTo(P[i][1] * k, Y(P[i][0]));
    ctx.closePath();
    ctx.fill();
    // 다리 사이 홈
    ctx.fillStyle = civ ? '#eef1f2' : '#e8e2d2';
    ctx.fillRect(-0.025 * k, Y(0.52), 0.05 * k, 0.46 * k);
    // 머리
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.arc(0, Y(1.68), 0.125 * k, 0, TAU); ctx.fill();
    if (civ) {
      // 두 손 든 자세 (NO-SHOOT)
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.09 * k;
      ctx.beginPath();
      ctx.moveTo(-0.28 * k, Y(1.34)); ctx.lineTo(-0.40 * k, Y(1.78));
      ctx.moveTo(0.28 * k, Y(1.34)); ctx.lineTo(0.40 * k, Y(1.78));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-0.40 * k, Y(1.82), 0.055 * k, 0, TAU);
      ctx.arc(0.40 * k, Y(1.82), 0.055 * k, 0, TAU);
      ctx.fill();
      ctx.restore();
      // 인질 표시 띠
      if (tg.hostage && k > 18) {
        ctx.fillStyle = '#c0392b';
        ctx.font = `700 ${Math.max(8, 0.11 * k)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('인질', 0, Y(0.30));
      }
    } else {
      // ── 흉부 스코어링 링 (중심 1.30 m) + 숫자 ──
      const cyM = 1.30;
      const rings = [ // [반폭m, 반높이m, 라벨]
        [0.315, 0.50, '7'], [0.245, 0.40, '8'], [0.17, 0.29, '9'], [0.10, 0.175, '10'],
      ];
      ctx.save();
      // 실루엣 밖으로 링이 나가지 않게 클리핑
      ctx.beginPath();
      ctx.moveTo(-P[0][1] * k, Y(P[0][0]));
      for (const [h, w] of P) ctx.lineTo(-w * k, Y(h));
      for (let i = P.length - 1; i >= 0; i--) ctx.lineTo(P[i][1] * k, Y(P[i][0]));
      ctx.closePath(); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = Math.max(0.8, 0.016 * k);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const numFont = Math.max(6, 0.10 * k);
      for (const [rw, rh, label] of rings) {
        ctx.beginPath();
        ctx.ellipse(0, Y(cyM), rw * k, rh * k, 0, 0, TAU);
        ctx.stroke();
        if (k >= 55) {
          ctx.font = `700 ${numFont}px sans-serif`;
          ctx.fillText(label, 0, Y(cyM + rh - 0.055));
          ctx.fillText(label, 0, Y(cyM - rh + 0.055));
        }
      }
      // 중심 X 링 (빨강)
      ctx.strokeStyle = '#c0392b';
      ctx.beginPath();
      ctx.ellipse(0, Y(cyM), 0.05 * k, 0.09 * k, 0, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.font = `800 ${Math.max(6, 0.11 * k)}px sans-serif`;
      if (k >= 30) ctx.fillText('X', 0, Y(cyM));
      // 헤드샷 존: 머리 중앙 링 + 점
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath(); ctx.arc(0, Y(1.68), 0.095 * k, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.arc(0, Y(1.68), Math.max(1.2, 0.032 * k), 0, TAU); ctx.fill();
      if (k >= 70) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `700 ${Math.max(6, 0.075 * k)}px sans-serif`;
        ctx.fillText('HEAD', 0, Y(1.86));
      }
      ctx.restore();
    }
    // ── 피탄 흔적 (총알구멍) ──
    for (const mk of tg.marks) {
      const hx = mk.dz * k, hy = Y(0.9 + mk.dy);
      ctx.fillStyle = civ ? '#c0392b' : '#efe9dc';
      ctx.beginPath(); ctx.arc(hx, hy, Math.max(1.2, 0.028 * k), 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(0.6, 0.008 * k);
      ctx.beginPath(); ctx.arc(hx, hy, Math.max(1.2, 0.028 * k), 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /* 스코프 밖 주변시: 1× 배율, 저해상 렌더 후 블러 */
  let outCv = null;
  function drawOuter(W, H, camYaw, camPitch) {
    const W2 = Math.max(2, W >> 1), H2 = Math.max(2, H >> 1);
    if (!outCv) outCv = document.createElement('canvas');
    if (outCv.width !== W2 || outCv.height !== H2) { outCv.width = W2; outCv.height = H2; }
    const octx = outCv.getContext('2d');
    const m = S.mission;
    const bg = BG[m.terrain];
    if (bg && bg.img) {
      // 사진: 화면 커버 + 미세 시차 (1× 근사)
      const img = bg.img;
      const meta = BG_META[m.terrain] || BG_META._default;
      const sc = Math.max(W2 / img.width, H2 / img.height) * 1.12;
      let dx = W2 / 2 - img.width * sc * (meta.xFrac ?? 0.5) - camYaw * 0.35;
      let dy = H2 / 2 - img.height * sc * meta.cFrac + camPitch * 0.35;
      dx = clamp(dx, W2 - img.width * sc, 0);
      dy = clamp(dy, H2 - img.height * sc, 0);
      octx.drawImage(img, dx, dy, img.width * sc, img.height * sc);
    } else {
      const ppmOut = H2 / 420; // 1× 육안 수직 시야 ≈ 24°
      renderWorld(octx, W2, H2, ppmOut, camYaw, camPitch, { mirage: false });
    }
    ctx.save();
    ctx.filter = 'blur(6px) brightness(0.8) saturate(0.9)';
    ctx.drawImage(outCv, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.restore();
  }

  /* 스코프 경통 / 접안 고무링 (절차적) */
  function drawScopeBody(cx, cy, R) {
    const annulus = (r0, r1, style) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, TAU);
      ctx.arc(cx, cy, r0, 0, TAU, true);
      ctx.fillStyle = style;
      ctx.fill();
    };
    // 렌즈 베젤
    annulus(R, R * 1.045, '#08090a');
    // 접안 고무링
    const rub = ctx.createRadialGradient(cx, cy, R * 1.045, cx, cy, R * 1.14);
    rub.addColorStop(0, '#1d1e1d');
    rub.addColorStop(0.45, '#111211');
    rub.addColorStop(1, '#050606');
    annulus(R * 1.045, R * 1.14, rub);
    // 경통
    annulus(R * 1.14, R * 1.21, '#161716');
    // 상단 좌측 금속 하이라이트
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.175, Math.PI * 0.9, Math.PI * 1.45);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = R * 0.05;
    ctx.stroke();
    // 렌즈 코팅 반사
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1.5, Math.PI * 1.05, Math.PI * 1.5);
    ctx.strokeStyle = 'rgba(150,200,230,0.13)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (S.phase !== 'play' && S.phase !== 'result') return;

    const t = now();
    const cx = W / 2, cy = H / 2;
    const fovMrad = 16 / S.mag * 17.4533;
    const ppm = H / fovMrad;

    let camYaw, camPitch;
    if (S.activeShot) {
      // 탄 비행 중: 스코프 고정 (격발 순간 카메라) — 궤적 관측
      camYaw = S.activeShot.cam.yaw;
      camPitch = S.activeShot.cam.pitch;
    } else {
      camYaw = S.aim.yaw + S.sway.yaw + S.recoil.yaw;
      camPitch = S.aim.pitch + S.sway.pitch + S.recoil.pitch;
      if (t < S.shakeT) {
        camYaw += (Math.random() - 0.5) * 3;
        camPitch += (Math.random() - 0.5) * 3;
      }
    }

    /* ── 패스 1: 스코프 밖 (1× 흐린 주변시) ── */
    drawOuter(W, H, camYaw, camPitch);

    /* ── 패스 2: 스코프 안 (확대·선명) ── */
    const R = Math.min(W, H) * 0.44;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    renderWorld(ctx, W, H, ppm, camYaw, camPitch, { mirage: true });
    // 비네팅
    const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    // 가장자리를 과하게 어둡게 하면 그 위의 레티클 눈금이 먼저 사라진다 — 완화
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(0.85, 'rgba(0,0,0,0.18)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // 렌즈 글레어
    const glr = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.4, cy + R * 0.4);
    glr.addColorStop(0, 'rgba(255,255,255,0.10)');
    glr.addColorStop(0.25, 'rgba(255,255,255,0)');
    ctx.fillStyle = glr;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    /* ── 스코프 경통 + 레티클 + 터렛 + LED ── */
    drawScopeBody(cx, cy, R);
    drawReticle(cx, cy, R, ppm);
    drawTurrets(cx, cy, R);
    drawZoomRing(cx, cy, R);

    /* ── 좌상단 최상단: 라운드 진행 점 ──
     * 테두리만 = 미진행 · 검은색 채움 = 성공 · 회색 채움 = 실패.
     * 현재 라운드는 녹색 링으로 표시. */
    {
      const dx0 = 292, dy0 = 40, r0 = 7, gap = 22;
      for (let i = 0; i < S.roundsTotal; i++) {
        const x = dx0 + i * gap;
        const st = S.roundResults[i];
        ctx.beginPath();
        ctx.arc(x, dy0, r0, 0, TAU);
        if (st === 'success') { ctx.fillStyle = '#101511'; ctx.fill(); }
        else if (st === 'fail') { ctx.fillStyle = '#8d968f'; ctx.fill(); }
        ctx.lineWidth = 2;
        ctx.strokeStyle = (i === S.roundIdx && st === 'pending')
          ? '#5fd75f' : 'rgba(18,22,18,0.9)';
        ctx.stroke();
      }
      // 현재 라운드 탄환: 발사 결과(명중/빗나감/민간인) + 남은 탄(테두리)
      const dy1 = dy0 + 24;
      for (let i = 0; i < S.shotsPerRound; i++) {
        const x = dx0 + i * gap;
        const sh = S.roundShots[i];
        ctx.beginPath();
        ctx.arc(x, dy1, 5, 0, TAU);
        if (sh) {
          ctx.fillStyle = sh === 'hit' ? '#8fd14f' : sh === 'civ' ? '#b06ad1' : '#e05c4a';
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(18,22,18,0.8)';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }
    }

    /* ── HIT/MISS 대형 표시 ── */
    if (S.bigMsg && t < S.bigMsg.until) {
      const age = S.bigMsg.until - t;
      ctx.save();
      ctx.globalAlpha = clamp(age / 0.5, 0, 1);
      ctx.fillStyle = S.bigMsg.color;
      ctx.font = '800 64px "Pretendard","Noto Sans KR",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 12;
      ctx.fillText(S.bigMsg.text, cx, cy - R * 0.32);
      ctx.restore();
    }

    if (S.controlMode === 'look' && !S.pointerLocked && S.phase === 'play') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cx - 190, cy + R * 0.55 - 20, 380, 40);
      ctx.fillStyle = '#d9ecd9';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('화면을 클릭해 조준을 시작하세요', cx, cy + R * 0.55 + 6);
    }
  }

  /* ================================================================
   * 레티클 — 총기 선택 화면에서 선택 (기본 mil-dot)
   * 전부 FFP: 배율과 무관하게 눈금이 실제 각도(mil/MOA)와 일치한다.
   * unit은 측거표 단위를 결정한다 (mrad | moa).
   * ================================================================ */
  const RETICLES = [
    { id: 'mildot',    name: 'Mil-Dot',      unit: 'mrad' },
    { id: 'ballistic', name: 'Ballistic CD', unit: 'mrad' },
    { id: 'p4',        name: 'Sniper P4',    unit: 'mrad' },
    { id: 'moa',       name: 'MOA',          unit: 'moa' },
    { id: 'dmr',       name: 'DMR8i',        unit: 'mrad' },
    { id: 'pso',       name: 'PSO-1',        unit: 'mrad' },
    { id: 'ffp',       name: 'FFP Mil-Hash', unit: 'mrad' },
  ];
  const reticleDef = () => RETICLES.find(r => r.id === S.reticle) || RETICLES[0];
  const reticleName = () => reticleDef().name;
  const reticleUnit = () => reticleDef().unit;

  /* ── 레티클 색상 ──
   * 선 굵기는 원본 그대로(실제 레티클처럼 가늘게 — 실측 정밀도 우선) 두고,
   * 가시성은 색으로 잡는다: 밝은 선(빨강/하양/초록)에 아주 얇은 검은
   * 테두리를 둘러 어두운 배경·밝은 배경 어디서든 읽히게 한다. */
  const RET_STYLES = [
    { id: 'red',   name: '빨간색', core: 'rgba(255,96,76,0.98)',  halo: 'rgba(0,0,0,0.88)' },  // 기본값
    { id: 'white', name: '흰색',   core: 'rgba(246,249,246,0.97)', halo: 'rgba(0,0,0,0.88)' },
    { id: 'green', name: '초록색', core: 'rgba(104,255,132,0.98)', halo: 'rgba(0,0,0,0.88)' },
    { id: 'black', name: '검정 (원본)' },
  ];
  const HALO_W = 0.6;    // 검은 테두리 오프셋 배수 — '아주 얇게'
  const RET_INK = 'rgba(8,10,8,0.95)';        // 기본 잉크 (현행과 동일)
  const retStyleDef = id =>
    RET_STYLES.find(s => s.id === (id ?? S.retStyle)) || RET_STYLES[0];

  /* 가는 선 두께 — 원본 그대로. 실제 레티클처럼 가늘어야 눈금 가장자리로
   * 표적 크기를 재는 실측이 정확하다. 가시성은 두께가 아니라 색 대비
   * (밝은 선 + 얇은 검은 테두리)로 확보한다. */
  function fineWidth(ppm, lw = 1) {
    return Math.max(1, ppm * 0.02) * lw;
  }

  /* ── 레티클 레이어 캐시 ──
   * 기하는 (type, ppm, R, 두께)에만 의존하고 조준에 따라 움직이지 않으므로
   * 매 프레임 다시 그릴 이유가 없다. 테두리·글로우까지 전부 구운 완성 레이어를
   * 오프스크린에 만들어 두고 프레임당 blit 1회만 한다 (drawOuter의 outCv 패턴).
   * 그 결과 합성이 아무리 복잡해도 프레임 비용은 현행보다 오히려 낮다. */
  const RET_PAD = 22;              // 헤일로·글로우가 잘리지 않도록 둘레 여유
  const HALO_OFF = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const RET_CACHE_MAX = 3;

  function buildReticleLayer(R, ppm, type, style, w) {
    const st = retStyleDef(style);
    const side = 2 * Math.ceil(R + RET_PAD);   // 짝수 → blit 오프셋이 정수라 리샘플링 없음
    const cv = document.createElement('canvas');
    cv.width = cv.height = side;
    const c = side / 2;
    const prev = ctx; ctx = cv.getContext('2d');
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.clip();   // 클리핑은 여기서 한 번만

    const wText = { ...w, textOutline: true };   // 숫자 외곽선은 코어 패스에서만
    const paint = (color, ox = 0, oy = 0, txt) =>
      drawReticlePaths(c + ox, c + oy, R, ppm, type, st.lw, color, txt ? wText : w);
    const h = Math.max(1, fineWidth(ppm, st.lw) * HALO_W);   // 얇은 검은 테두리 오프셋
    const sc = clamp(w.scale ?? S.stageScale ?? 1, 0.4, 1.25);

    // 1) 테두리(헤일로) — 8방향 오프셋. shadowBlur보다 선명하다.
    if (st.halo) for (const [ox, oy] of HALO_OFF) paint(st.halo, ox * h, oy * h);
    // 2) 부드러운 광훈 — 그림자를 켠 채 두 번 겹쳐 광량을 축적
    if (st.glow) {
      ctx.save();
      ctx.shadowColor = st.glow;
      ctx.shadowBlur = clamp(7 / sc, 3, 18);
      paint(RET_INK); paint(RET_INK);
      ctx.restore();
    }
    // 3) 코어
    paint(st.core || RET_INK, 0, 0, true);
    // 4) 중앙 조명 존 — 실제 조명 스코프처럼 가운데만 발광
    if (st.center) {
      const rc = clamp(3.5 * ppm, R * 0.10, R * 0.50);
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rc, 0, TAU); ctx.clip();
      ctx.clearRect(c - rc - 2, c - rc - 2, rc * 2 + 4, rc * 2 + 4); // 클립 안에서만 지워진다
      for (const [ox, oy] of HALO_OFF) paint('rgba(4,6,4,0.85)', ox * h, oy * h);
      ctx.save();
      ctx.shadowColor = st.center; ctx.shadowBlur = clamp(4 / sc, 2, 10);
      paint(st.center);
      ctx.restore();
      paint(st.center, 0, 0, true);
      ctx.restore();
    }
    ctx.restore();
    ctx = prev;
    return cv;
  }

  /* 레티클 렌더 — 캐시된 완성 레이어를 blit.
   * opts.cache === false 면 캐시를 건너뛴다 (미리보기가 메인 캐시를 밀어내지 않도록).
   * opts.scale 로 stageScale 보정을 무시할 수 있다 (CSS 축소가 없는 미리보기 캔버스). */
  function drawReticle(cx, cy, R, ppm, type = S.reticle, style, opts = {}) {
    const st = retStyleDef(style);
    const w = { scale: opts.scale, noCap: opts.noCap };
    let lay;
    if (opts.cache === false) {
      lay = buildReticleLayer(R, ppm, type, st.id, w);
    } else {
      const sc = opts.scale ?? S.stageScale ?? 1;
      const key = `${type}|${st.id}|${ppm.toFixed(1)}|${R.toFixed(1)}|${sc.toFixed(2)}`;
      lay = retLayers.get(key);
      if (!lay) {
        lay = buildReticleLayer(R, ppm, type, st.id, w);
        retLayers.set(key, lay);
        if (retLayers.size > RET_CACHE_MAX) retLayers.delete(retLayers.keys().next().value);
      }
    }
    ctx.drawImage(lay, Math.round(cx - lay.width / 2), Math.round(cy - lay.height / 2));
  }

  /* 레티클 경로만 그린다 — 색(inkColor)과 가는 선 두께 배수(lw)는 호출자가 지정.
   * 시인성 스타일 합성은 drawReticle()이 담당한다. */
  function drawReticlePaths(cx, cy, R, ppm, type, lw, inkColor, w) {
    ctx.save();
    // 원형 클리핑은 호출자가 한 번만 건다 — 헤일로를 오프셋으로 그릴 때
    // 클립까지 함께 밀리면 가장자리가 울퉁불퉁해지기 때문이다.
    const ink = inkColor;
    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fine = fineWidth(ppm, lw, w);
    /* 눈금 숫자: 논리 10px 고정이던 것을 stageScale 역보정해 기기와 무관하게
     * 같은 CSS 크기로 읽히게 한다 (모바일에선 기존 4.4 CSS px → 11 CSS px). */
    const tsc = clamp(w?.scale ?? S.stageScale ?? 1, 0.4, 1.3);
    const fontPx = Math.max(10 / tsc, ppm * 0.26);
    ctx.font = `700 ${fontPx}px sans-serif`;
    /* 숫자는 배경이 무엇이든 읽혀야 하므로 코어 패스에서 밝은 외곽선을 두른다.
     * (테두리 없는 '굵게' 스타일에서도 숫자만은 확실히 보이게) */
    /* 숫자는 선과 같은 색으로 채우고 얇은 검은 외곽선을 둘러,
     * 밝은 풀밭·어두운 벽 어디에 걸려도 판독되게 한다. */
    const label = (s, x, y) => {
      if (w?.textOutline) {
        ctx.save();
        ctx.strokeStyle = 'rgba(4,6,4,0.9)';
        ctx.lineWidth = Math.max(2, fontPx * 0.12);
        ctx.lineJoin = 'round'; ctx.miterLimit = 2;
        ctx.strokeText(s, x, y);
        ctx.restore();
      }
      ctx.fillText(s, x, y);
    };
    // 숫자가 눈금 간격보다 커지면 겹치므로, 그 경우엔 숫자를 감춘다
    const fits = spacing => spacing > fontPx * 1.9;

    const cross = () => {
      ctx.lineWidth = fine;
      ctx.beginPath();
      ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
      ctx.stroke();
    };
    const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };
    // 외곽 두꺼운 포스트 (fromMil부터 바깥으로, 두께 thickMil)
    const posts = (fromMil, thickMil, dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]]) => {
      ctx.lineWidth = Math.max(3, ppm * thickMil);
      ctx.beginPath();
      dirs.forEach(([dx, dy]) => {
        const from = Math.min(R * 0.92, fromMil * ppm);
        ctx.moveTo(cx + dx * from, cy + dy * from);
        ctx.lineTo(cx + dx * R, cy + dy * R);
      });
      ctx.stroke();
    };
    // mil 해시 십자 (±maxU, numEvery 간격 숫자)
    const hashCross = (unitPx, maxU, numEvery) => {
      ctx.lineWidth = fine;
      for (let u = -maxU; u <= maxU; u++) {
        if (!u) continue;
        const len = u % 5 === 0 ? 0.24 : (u % 2 === 0 ? 0.16 : 0.09);
        const hx = cx + u * unitPx, hy = cy - u * unitPx;
        if (Math.abs(u * unitPx) >= R * 0.92) continue;
        ctx.beginPath();
        ctx.moveTo(hx, cy - len * ppm); ctx.lineTo(hx, cy + len * ppm);
        ctx.moveTo(cx - len * ppm, hy); ctx.lineTo(cx + len * ppm, hy);
        ctx.stroke();
        if (u % numEvery === 0 && fits(unitPx * numEvery)) {
          label(Math.abs(u), hx, cy + 0.62 * ppm);
          label(Math.abs(u), cx + 0.55 * ppm, hy);
        }
      }
    };
    /* 0.1 단위 미세 눈금 (실측용) — 0.5 위치는 조금 길게.
     * 간격이 2px 미만이면 뭉개져서 오히려 정밀도를 해치므로 생략한다.
     * axes: 'both' = 십자 전체 · 'h' = 수평만 · 'down' = 하방 수직만 */
    const microTicks = (unitPx, maxU, axes = 'both') => {
      const step = unitPx * 0.1;
      if (step < 2) return;
      ctx.lineWidth = fine;
      ctx.beginPath();
      for (let t = 1; t < maxU * 10; t++) {
        if (t % 10 === 0) continue;                       // 정수 위치는 기존 해시
        const len = (t % 5 === 0 ? 0.07 : 0.04) * ppm;
        const off = t * step;
        if (off >= R * 0.92) break;
        if (axes === 'down') {
          ctx.moveTo(cx - len, cy + off); ctx.lineTo(cx + len, cy + off);
          continue;
        }
        for (const s of [-1, 1]) {
          ctx.moveTo(cx + s * off, cy - len); ctx.lineTo(cx + s * off, cy + len);
          if (axes === 'both') {
            ctx.moveTo(cx - len, cy + s * off); ctx.lineTo(cx + len, cy + s * off);
          }
        }
      }
      ctx.stroke();
    };

    switch (type) {
      case 'ballistic': { // 크리스마스트리 홀드오버 격자
        cross();
        hashCross(ppm, 10, 2);
        microTicks(ppm, 10);
        for (let down = 1; down <= 9; down++) {
          const y = cy + down * ppm;
          if (y > cy + R * 0.92) break;
          const width = Math.min(down, 6);
          ctx.lineWidth = fine;
          for (let wz = 0.5; wz <= width; wz += 0.5) {
            for (const s of [-1, 1]) {
              const x = cx + s * wz * ppm;
              const dotL = (wz * 2) % 2 === 0 ? 0.07 : 0.045;
              ctx.beginPath();
              ctx.moveTo(x - dotL * ppm, y); ctx.lineTo(x + dotL * ppm, y);
              ctx.moveTo(x, y - dotL * ppm); ctx.lineTo(x, y + dotL * ppm);
              ctx.stroke();
            }
          }
        }
        posts(11, 0.1);
        break;
      }
      case 'p4': { // 독일식 4번: 좌/우/하 태이퍼 포스트
        cross();
        ctx.lineWidth = fine;
        for (let m = 1; m <= 3; m++) for (const s of [-1, 1]) {
          const x = cx + s * m * ppm;
          ctx.beginPath();
          ctx.moveTo(x, cy - 0.09 * ppm); ctx.lineTo(x, cy + 0.09 * ppm);
          ctx.stroke();
        }
        const taper = (dx, dy) => {
          const w0 = 0.55 * ppm, w1 = Math.max(1.5, 0.09 * ppm);
          const x0 = cx + dx * R, y0 = cy + dy * R;
          const x1 = cx + dx * Math.min(R * 0.9, 3 * ppm), y1 = cy + dy * Math.min(R * 0.9, 3 * ppm);
          const px = -dy, py = dx;
          ctx.beginPath();
          ctx.moveTo(x0 + px * w0 / 2, y0 + py * w0 / 2);
          ctx.lineTo(x1 + px * w1 / 2, y1 + py * w1 / 2);
          ctx.lineTo(x1 - px * w1 / 2, y1 - py * w1 / 2);
          ctx.lineTo(x0 - px * w0 / 2, y0 - py * w0 / 2);
          ctx.closePath(); ctx.fill();
        };
        taper(-1, 0); taper(1, 0); taper(0, 1);
        microTicks(ppm, 3);
        break;
      }
      case 'moa': { // MOA 해시 (2 MOA 간격, 10 MOA 숫자)
        const pm = ppm * 0.2908882; // px per MOA
        cross();
        ctx.lineWidth = fine;
        for (let a = 2; a <= 60; a += 2) {
          if (a * pm >= R * 0.92) break;
          const len = a % 10 === 0 ? 0.24 * ppm : 0.10 * ppm;
          for (const s of [-1, 1]) {
            const hx = cx + s * a * pm, hy = cy + s * a * pm;
            ctx.beginPath();
            ctx.moveTo(hx, cy - len); ctx.lineTo(hx, cy + len);
            ctx.moveTo(cx - len, hy); ctx.lineTo(cx + len, hy);
            ctx.stroke();
          }
          if (a % 10 === 0 && fits(pm * 10)) {
            label(a, cx + a * pm, cy + 0.62 * ppm);
            label(a, cx - a * pm, cy + 0.62 * ppm);
            label(a, cx + 0.6 * ppm, cy + a * pm);
            label(a, cx + 0.6 * ppm, cy - a * pm);
          }
        }
        microTicks(pm * 10, 6);   // 1 MOA 보조 눈금 (10 MOA 블록의 0.1)
        posts(62 * 0.2908882, 0.12);
        break;
      }
      case 'dmr': { // DMR8i: 수평 해시 + 하방 드롭 라인 + 스타디아 측거 바 (1 m 표적)
        const lim = R * 0.92;
        // 수평 본선 + 하방 수직선 — 상단 수직선이 없는 것이 특징
        ctx.lineWidth = fine;
        ctx.beginPath();
        ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
        ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + R);
        ctx.stroke();
        // 0.5 mil 짧은 / 1 mil 중간 / 5 mil 긴 해시 — 수평 ±15 mil, 수직 하방 10 mil
        ctx.beginPath();
        for (let t = 1; t <= 30; t++) {
          const off = t * 0.5 * ppm;
          if (off >= lim) break;
          const len = (t % 10 === 0 ? 0.30 : t % 2 === 0 ? 0.18 : 0.10) * ppm;
          for (const s of [-1, 1]) {
            ctx.moveTo(cx + s * off, cy - len); ctx.lineTo(cx + s * off, cy + len);
          }
          if (t <= 20) {
            ctx.moveTo(cx - len, cy + off); ctx.lineTo(cx + len, cy + off);
          }
        }
        ctx.stroke();
        microTicks(ppm, 15, 'h');
        microTicks(ppm, 10, 'down');              // 드롭 라인도 0.1 mil 실측 눈금
        dot(cx, cy, Math.max(1.2, 0.06 * ppm));   // 중앙 조준점 (조명 도트)
        // 스타디아 측거 바 — 기준선~바 높이 = 10/n mil (1 m 표적, 숫자 n = ×100 m)
        const by = cy + 7.2 * ppm;
        if (by < cy + lim) {
          ctx.lineWidth = fine;
          ctx.beginPath(); ctx.moveTo(cx - 5.6 * ppm, by); ctx.lineTo(cx + 5.2 * ppm, by); ctx.stroke();
          ctx.font = `700 ${Math.max(9 / tsc, ppm * 0.2)}px sans-serif`;
          for (const [n, bx] of [[8, -5.2], [7, -3.9], [6, -2.6], [5, -1.3], [4, 1.3], [3, 2.7], [2, 4.3]]) {
            const x = cx + bx * ppm, y = by - (10 / n) * ppm;
            ctx.beginPath(); ctx.moveTo(x - 0.4 * ppm, y); ctx.lineTo(x + 0.4 * ppm, y); ctx.stroke();
            if (fits(ppm * 0.9)) label(n, x, y + 0.42 * ppm);
          }
          ctx.font = `700 ${fontPx}px sans-serif`;
        }
        posts(15, 0.4, [[-1, 0], [1, 0]]);   // 좌/우 포스트
        posts(12, 0.4, [[0, 1]]);            // 하단 포스트 (상단 포스트 없음)
        break;
      }
      case 'pso': { // PSO-1 (SVD식): 윗눈금 1-mil 스케일 + 슈브론 조준점 + 측거 곡선
        const lim = R * 0.92;
        // 수평 본선 — 좌/우 포스트 사이
        ctx.lineWidth = fine;
        ctx.beginPath();
        ctx.moveTo(cx - Math.min(lim, 10.5 * ppm), cy);
        ctx.lineTo(cx + Math.min(lim, 10.5 * ppm), cy);
        ctx.stroke();
        // 1-mil 눈금 — 본선 위쪽으로만 솟는 사각 이빨
        ctx.lineWidth = Math.max(1.5, ppm * 0.12);
        ctx.beginPath();
        for (let m = 1; m <= 10; m++) for (const s of [-1, 1]) {
          const x = cx + s * m * ppm;
          if (Math.abs(x - cx) >= lim) continue;
          ctx.moveTo(x, cy); ctx.lineTo(x, cy - 0.28 * ppm);
        }
        ctx.stroke();
        if (fits(ppm) && 10 * ppm < lim) {
          label('10', cx - 10 * ppm, cy + 0.6 * ppm);
          label('10', cx + 10 * ppm, cy + 0.6 * ppm);
        }
        microTicks(ppm, 10, 'h');   // 수평 스케일만 — 수직은 슈브론 존
        // 슈브론 조준점 — 꼭짓점이 조준 중심
        ctx.lineWidth = Math.max(1.4, ppm * 0.07);
        ctx.beginPath();
        ctx.moveTo(cx - 0.5 * ppm, cy + 0.9 * ppm);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + 0.5 * ppm, cy + 0.9 * ppm);
        ctx.stroke();
        // 하방 수직 세선 (상단 수직선 없음)
        ctx.lineWidth = fine;
        ctx.beginPath(); ctx.moveTo(cx, cy + 1.3 * ppm); ctx.lineTo(cx, cy + lim); ctx.stroke();
        posts(10.6, 0.5, [[-1, 0], [1, 0]]);
        // 스타디아 측거 곡선 (좌하단): 1.5 m 상단 곡선 + 0.5 m 하단 곡선, 숫자 = ×100 m
        const bx0 = cx - 8.6 * ppm, bx1 = cx - 1.6 * ppm, by = cy + 6.8 * ppm;
        if (by < cy + R * 0.95) {
          ctx.lineWidth = fine;
          ctx.beginPath(); ctx.moveTo(bx0, by); ctx.lineTo(bx1, by); ctx.stroke();
          const curve = h10 => {   // h10: 표적 높이 [dm] — 곡선 높이 ∝ h10/n
            ctx.beginPath();
            for (let n = 10; n >= 2; n -= 0.5) {
              const x = lerp(bx0, bx1, (10 - n) / 8);
              const h = (h10 / n) * ppm * 0.35; // 시각화 축소 스케일
              n === 10 ? ctx.moveTo(x, by - h) : ctx.lineTo(x, by - h);
            }
            ctx.stroke();
          };
          curve(15); curve(5);
          // 수치별 세로 눈금 — 곡선 위에 세워 표적 상단을 맞추는 기준선
          ctx.beginPath();
          for (let n = 2; n <= 10; n += 2) {
            const x = lerp(bx0, bx1, (10 - n) / 8);
            const h = (15 / n) * ppm * 0.35;
            ctx.moveTo(x, by - h); ctx.lineTo(x, by - h - 0.3 * ppm);
          }
          ctx.stroke();
          if (fits(ppm * 0.9)) {
            ctx.font = `700 ${Math.max(9 / tsc, ppm * 0.2)}px sans-serif`;
            for (const n of [10, 8, 6, 4, 2]) {
              const x = lerp(bx0, bx1, (10 - n) / 8);
              label(n, x, by - (15 / n) * ppm * 0.35 - 0.3 * ppm - 0.3 * ppm);
            }
            label('1.5', bx1 + 0.6 * ppm, by - (15 / 2) * ppm * 0.35);
            label('0.5', bx1 + 0.6 * ppm, by - (5 / 2) * ppm * 0.35);
            ctx.font = `700 ${fontPx}px sans-serif`;
          }
        }
        break;
      }
      case 'ffp': { // 미세 mil 해시 (홀드오버 격자 없음)
        cross();
        hashCross(ppm, 10, 2);
        microTicks(ppm, 10);
        posts(11, 0.1);
        break;
      }
      default: { // mil-dot
        cross();
        const dr = Math.max(1.4, ppm * 0.1);
        for (let m = 1; m <= 4; m++) for (const s of [-1, 1]) {
          dot(cx + s * m * ppm, cy, dr);
          dot(cx, cy + s * m * ppm, dr);
        }
        microTicks(ppm, 5);
        posts(5, 0.36);
        break;
      }
    }
    ctx.restore();
  }

  /* 레티클 미리보기 (총기 선택 화면) — 밝은 배경에 ±8 mil 시야.
   * CSS 축소가 없는 캔버스이므로 stageScale 보정을 끄고(scale:1),
   * 메인 스코프의 레이어 캐시를 오염시키지 않도록 캐시를 건너뛴다. */
  function drawReticlePreview(cv, type, style = S.retStyle) {
    const c = cv.getContext('2d');
    // 밝은 배경에서는 흰 테두리가, 어두운 배경에서는 검은 코어가 안 보인다.
    // 두 경우를 한 카드에 같이 담아야 스타일 차이가 드러난다.
    const g = c.createLinearGradient(0, 0, cv.width, cv.height);
    g.addColorStop(0, '#e9ece9'); g.addColorStop(0.52, '#9aa398'); g.addColorStop(1, '#1b221a');
    c.fillStyle = g;
    c.fillRect(0, 0, cv.width, cv.height);
    const prev = ctx; ctx = c;
    // scale:1 — 카드 캔버스는 CSS 축소가 없다.
    drawReticle(cv.width / 2, cv.height / 2, cv.width * 0.52, cv.width / 16, type,
      style, { cache: false, scale: 1 });
    ctx = prev;
  }

  /* 터렛 노브: 상단(엘리베이션) / 우측(윈디지), 클릭에 따라 눈금 밴드 회전
   * — 1.5배 확대, 화면 안에 들어오도록 스코프 링에 살짝 겹쳐 배치 */
  const TURRET_SCALE = 1.5;
  function drawTurrets(cx, cy, R) {
    const draw = (side, clicks, label) => {
      ctx.save();
      ctx.translate(cx, cy);
      if (side === 'right') ctx.rotate(Math.PI / 2);
      ctx.translate(0, -(R - 22));
      ctx.scale(TURRET_SCALE, TURRET_SCALE);
      // 노브 몸통
      const kw = Math.min(190, R * 0.52), kh = 46;
      ctx.fillStyle = '#141614';
      roundRectAt(-kw / 2, -kh, kw, kh, 8);
      ctx.fill();
      ctx.strokeStyle = '#333733'; ctx.lineWidth = 2;
      roundRectAt(-kw / 2, -kh, kw, kh, 8);
      ctx.stroke();
      // 널링
      ctx.strokeStyle = '#2a2d2a'; ctx.lineWidth = 2;
      for (let x = -kw / 2 + 6; x < kw / 2 - 4; x += 7) {
        ctx.beginPath(); ctx.moveTo(x, -kh + 4); ctx.lineTo(x, -kh + 12); ctx.stroke();
      }
      // 눈금 밴드: 0.1 mil 마다 작은 눈금, 1 mil 마다 숫자
      const mil = clicks * 0.1;
      const pxPerMil = 42;
      ctx.save();
      ctx.beginPath(); ctx.rect(-kw / 2 + 4, -kh + 14, kw - 8, kh - 18); ctx.clip();
      ctx.fillStyle = '#dfe6df'; ctx.strokeStyle = '#9aa59a';
      ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const c0 = Math.floor(mil - kw / pxPerMil), c1 = Math.ceil(mil + kw / pxPerMil);
      for (let v = c0 * 10; v <= c1 * 10; v++) { // v = 0.1 mil 단위
        const x = (v * 0.1 - mil) * -pxPerMil; // 다이얼 올리면 밴드가 왼쪽으로
        if (x < -kw / 2 || x > kw / 2) continue;
        const major = v % 10 === 0;
        ctx.lineWidth = major ? 1.6 : 0.8;
        ctx.beginPath();
        ctx.moveTo(x, -kh + 15); ctx.lineTo(x, -kh + (major ? 27 : 21));
        ctx.stroke();
        if (major) ctx.fillText((v / 10).toString(), x, -kh + 29);
      }
      ctx.restore();
      // 인덱스 마커
      ctx.fillStyle = '#e0a03c';
      ctx.beginPath();
      ctx.moveTo(0, -2); ctx.lineTo(-5, 7); ctx.lineTo(5, 7); ctx.closePath();
      ctx.fill();
      // 라벨: 노브 아래쪽 (확대로 상단이 화면 밖에 걸리지 않게 하단 배치)
      ctx.fillStyle = 'rgba(8,10,8,0.6)';
      roundRectAt(-37, 9, 74, 15, 4);
      ctx.fill();
      ctx.fillStyle = '#cfe3d4'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 16.5);
      ctx.restore();
    };
    draw('top', S.dial.elev, `ELEV ${fmt(S.dial.elev * 0.1, 1)}`);
    draw('right', S.dial.wind, `WIND ${fmt(S.dial.wind * 0.1, 1)}`);
    function roundRectAt(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  /* 배율 조절 링: 스코프 링 9시~6시 원호를 드래그해 배율 조정.
   * 9시 = 최소 배율, 6시 = 최대(25×). 현재 배율 위치에 스로우 레버 표시. */
  const ZR_A0 = Math.PI / 2;   // 6시 (화면 좌표: 아래)
  const ZR_A1 = Math.PI;       // 9시 (왼쪽)
  function zoomRingAngle(mag) {
    const mn = S.magMin || 5;
    const f = clamp((mag - mn) / (25 - mn), 0, 1);
    return ZR_A1 - f * (ZR_A1 - ZR_A0);
  }
  function magFromRingAngle(a) {
    const mn = S.magMin || 5;
    const f = clamp((ZR_A1 - a) / (ZR_A1 - ZR_A0), 0, 1);
    return Math.round(mn + f * (25 - mn));
  }
  function drawZoomRing(cx, cy, R) {
    const mn = S.magMin || 5;
    const rIn = R * 1.05, rOut = R * 1.13; // 접안 고무링 위 밴드 (화면 안에 들어오는 반경)
    ctx.save();
    // 밴드
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, ZR_A0, ZR_A1);
    ctx.arc(cx, cy, rIn, ZR_A1, ZR_A0, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(16,18,16,0.95)';
    ctx.fill();
    ctx.strokeStyle = '#3a413a'; ctx.lineWidth = 1.5; ctx.stroke();
    // 눈금 + 배율 숫자
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let mg = mn; mg <= 25; mg++) {
      const a = zoomRingAngle(mg);
      const major = mg === mn || mg === 25 || mg % 5 === 0;
      const rT = major ? rIn + (rOut - rIn) * 0.42 : rIn + (rOut - rIn) * 0.25;
      ctx.strokeStyle = major ? '#cfd6cf' : '#6e766e';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
      ctx.lineTo(cx + Math.cos(a) * rT, cy + Math.sin(a) * rT);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = '#cfd6cf'; ctx.font = '700 11px monospace';
        const rL = rOut - (rOut - rIn) * 0.3;
        ctx.fillText(String(mg), cx + Math.cos(a) * rL, cy + Math.sin(a) * rL);
      }
    }
    // 스로우 레버 (현재 배율 위치)
    const a = zoomRingAngle(S.mag);
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = '#0b0c0b';
    ctx.strokeStyle = '#4a524a'; ctx.lineWidth = 1.5;
    roundRect(R * 0.99, -R * 0.030, R * 0.145, R * 0.060, R * 0.028);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e0a03c';
    ctx.beginPath(); ctx.arc(R * 1.105, 0, R * 0.020, 0, TAU); ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 현재 배율 표시 (7시30 방향 고정)
    const tA = Math.PI * 0.75, tR = R * 1.30;
    ctx.fillStyle = '#cfe3d4';
    ctx.font = '700 17px monospace';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6;
    ctx.fillText(`${S.mag}×`, cx + Math.cos(tA) * tR, cy + Math.sin(tA) * tR);
    ctx.restore();
  }


  /* ---------------- 명중률 분석 ---------------- */
  function runAnalysis() {
    if (S.phase !== 'play') return;
    document.exitPointerLock && document.exitPointerLock();
    $('analysis').classList.remove('hidden');
    $('analysis-table').innerHTML = '<p style="color:var(--dim)">계산 중...</p>';

    setTimeout(() => {
      const g = geom();
      const env = { ...S.mission.env, coriolis: true };
      const p = ammoParams();
      let delta = 0, r = null;
      for (let i = 0; i < 4; i++) {
        r = Ballistics.solveAtRange(p, env, { elevRad: g.incl + S.zeroAngle + delta, azRad: 0 }, g.Dh, { dt: 0.003 });
        if (!r) break;
        delta += (g.ty - r.y) / g.Dh;
      }
      let az = 0;
      if (r) az = -(r.z / g.Dh);
      const baseLaunch = { elevRad: g.incl + S.zeroAngle + delta, azRad: az };
      const errors = {
        sigmaMV: S.ammo.mvSd,
        sigmaElevMrad: 0.12 * S.rifle.swayFactor + 0.06,
        sigmaAzMrad: 0.10 * S.rifle.swayFactor + 0.06,
        sigmaWind: 0.4 + S.mission.spotterErr * 2.0,
      };
      const target = { centerY: g.ty, centerZ: 0, halfW: g.halfW, halfH: g.halfH };
      const exp = Ballistics.experimentalHitAnalysis(p, env, baseLaunch, g.Dh, errors, target, 400);
      const ana = Ballistics.analyticHitAnalysis(p, env, baseLaunch, g.Dh, errors, target);
      drawScatter(exp, target, g);
      renderAnalysisTable(exp, ana);
    }, 30);
  }
  function drawScatter(exp, target, g) {
    const c = $('scatter-canvas'), x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    if (!exp) return;
    const cx = c.width / 2, cy = c.height / 2;
    const spread = Math.max(target.halfW * 2.2, target.halfH * 2.2, exp.CEP * 3, 0.5);
    const sc = Math.min(c.width, c.height) / (2 * spread);
    x.strokeStyle = '#28382c'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, cy); x.lineTo(c.width, cy); x.moveTo(cx, 0); x.lineTo(cx, c.height); x.stroke();
    x.strokeStyle = '#e05c4a'; x.lineWidth = 1.6;
    x.strokeRect(cx + (target.centerZ - target.halfW) * sc,
                 cy - (target.centerY - g.ty + target.halfH) * sc,
                 target.halfW * 2 * sc, target.halfH * 2 * sc);
    const mzx = cx + exp.meanZ * sc, mzy = cy - (exp.meanY - g.ty) * sc;
    x.strokeStyle = '#8fd14f';
    x.beginPath(); x.arc(mzx, mzy, exp.CEP * sc, 0, TAU); x.stroke();
    x.fillStyle = 'rgba(90,160,220,0.75)';
    for (const p of exp.impacts) {
      x.beginPath();
      x.arc(cx + p.z * sc, cy - (p.y - g.ty) * sc, 1.6, 0, TAU);
      x.fill();
    }
    x.fillStyle = '#7d9484'; x.font = '11px sans-serif'; x.textAlign = 'left';
    x.fillText(`탄착군 n=${exp.n} · 격자 중심 = 표적 중심 · 녹색 원 = CEP`, 10, c.height - 10);
  }
  function renderAnalysisTable(exp, ana) {
    if (!exp || !ana) { $('analysis-table').innerHTML = '<p class="bad">계산 실패 (사거리 초과?)</p>'; return; }
    const row = (name, a, b, d = 2) =>
      `<tr><td>${name}</td><td>${fmt(a, d)}</td><td>${fmt(b, d)}</td><td>${fmt(Math.abs(a - b), d)}</td></tr>`;
    $('analysis-table').innerHTML =
      `<table>
        <caption>두 방법의 명중률 예측 비교 (단위: DEP/REP/CEP = m)</caption>
        <tr><th></th><th>해석적 방법</th><th>실험적 방법</th><th>오차</th></tr>
        ${row('편향공산오차 DEP [m]', ana.DEP, exp.DEP)}
        ${row('수직공산오차 REP [m]', ana.REP, exp.REP)}
        ${row('원형공산오차 CEP [m]', ana.CEP, exp.CEP)}
        ${row('표적 명중률 [%]', ana.hitProb * 100, exp.hitProb * 100, 1)}
      </table>
      <p style="color:var(--dim);font-size:12px;margin-top:12px;line-height:1.7">
      오차 요인: 총구속도 σ=${fmt(S.ammo.mvSd, 1)} m/s, 조준(고각/방위) σ≈0.1~0.2 mil,
      바람 관측 σ=${fmt(0.4 + S.mission.spotterErr * 2, 1)} m/s.<br>
      해석적 방법: 편미분 민감도 합성 σ² = Σ(∂·σ)² · 실험적 방법: 몬테카를로 400발 탄착군.</p>`;
  }

  /* ---------------- 메뉴: 아이콘 그리드 + 상세 화면 ---------------- */
  function srcLine(item) {
    if (!item.descSourceUrl) return '';
    const label = item.descSource === 'wikipedia' ? '위키피디아' : '공식 페이지';
    return `<div class="src">출처(${label}): <a href="${item.descSourceUrl}" target="_blank" rel="noopener">${new URL(item.descSourceUrl).hostname}</a></div>`;
  }

  /* 총기 측면 실루엣 (절차적) */
  function drawRifleIcon(cv, id, scale = 1) {
    const c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.save();
    c.translate(W / 2, H / 2);
    c.scale(scale, scale);
    const ink = '#222824';
    c.fillStyle = ink; c.strokeStyle = ink;
    c.lineWidth = 2; c.lineJoin = 'round';
    const rect = (x, y, w, h, r = 0) => {
      c.beginPath();
      if (r) {
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
      } else c.rect(x, y, w, h);
      c.closePath(); c.fill();
    };
    const poly = pts => {
      c.beginPath();
      pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
      c.closePath(); c.fill();
    };
    // 공통: 스코프 + 마운트
    const scopeAt = (x, w) => {
      rect(x, -21, w, 8, 4);                 // 경통
      rect(x - 6, -20, 8, 6, 2);             // 접안
      rect(x + w - 2, -21.5, 9, 9, 3);       // 대물
      rect(x + w * 0.3, -14, 5, 5);          // 마운트
      rect(x + w * 0.75, -14, 5, 5);
    };
    switch (id) {
      case 'rem700': // 클래식 수렵형 원피스 스톡
        poly([[-96, 6], [-60, -4], [-20, -6], [40, -6], [40, 2], [-16, 4], [-52, 14], [-88, 18]]);
        rect(-20, -9, 62, 8, 2);              // 리시버
        rect(40, -7, 62, 4);                  // 총열
        scopeAt(-16, 48);
        poly([[-6, 2], [2, 12], [8, 12], [4, 2]]); // 방아쇠울
        break;
      case 'trg42': // 각진 전술 스톡 + 수직 그립
        poly([[-98, -6], [-70, -6], [-70, 12], [-86, 14], [-98, 10]]);   // 버트
        rect(-72, -8, 46, 14, 2);             // 스톡 몸통
        poly([[-30, 4], [-24, 20], [-16, 20], [-18, 4]]);                // 그립
        rect(-30, -9, 66, 10, 2);             // 리시버/섀시
        rect(36, -7, 58, 5);                  // 총열
        rect(94, -8, 8, 7);                   // 머즐브레이크
        scopeAt(-22, 52);
        rect(20, 3, 30, 4);                   // 핸드가드 하부
        break;
      case 'axsr': // 접철 섀시 + 스켈레톤 스톡
        rect(-98, -7, 10, 20, 2);             // 버트패드
        rect(-88, -3, 26, 4);                 // 스켈레톤 상봉
        rect(-88, 8, 26, 4);                  // 하봉
        rect(-64, -8, 30, 16, 2);             // 접철부/그립부
        poly([[-40, 4], [-34, 20], [-26, 20], [-28, 4]]);
        rect(-38, -10, 70, 11, 2);            // 리시버(모노리식 레일)
        rect(-38, -12, 70, 3);
        rect(32, 0, 34, 8, 2);                // 핸드가드
        rect(32, -7, 60, 5);                  // 총열
        rect(92, -9, 10, 9);                  // 브레이크
        scopeAt(-28, 56);
        break;
      case 'm107a1': // 대구경 반자동: 길고 각진 상부 + 화살촉 브레이크
        rect(-100, -8, 14, 20, 2);            // 버트
        rect(-86, -6, 30, 14);
        rect(-58, -11, 118, 13, 2);           // 길쭉한 리시버
        poly([[-24, 2], [-18, 20], [-10, 20], [-12, 2]]);
        rect(-46, 2, 20, 12, 2);              // 탄창(대형)
        rect(60, -8, 34, 6);                  // 총열
        poly([[94, -11], [106, -5], [94, 1]]); // 화살촉 브레이크
        scopeAt(-30, 54);
        poly([[20, 2], [34, 14], [40, 14], [40, 10], [28, 2]]); // 양각대 접힘
        break;
      case 'm200': // 인터벤션: 튜브 섀시 + 스켈레톤 스톡 + 모노포드
        rect(-102, -6, 12, 18, 3);
        rect(-90, -2, 22, 4);                 // 상봉
        rect(-90, 9, 22, 3);                  // 하봉
        rect(-92, 12, 5, 10);                 // 모노포드
        rect(-68, -9, 36, 18, 3);             // 후방 섀시 블록
        poly([[-36, 4], [-30, 20], [-22, 20], [-24, 4]]);
        rect(-34, -10, 58, 11, 2);            // 리시버
        rect(24, -4, 26, 8, 3);               // 튜브 핸드가드
        rect(24, -7, 66, 5);                  // 총열
        rect(90, -9, 12, 9, 2);               // 대형 브레이크
        scopeAt(-26, 50);
        poly([[30, 4], [40, 16], [46, 16], [46, 12], [36, 4]]);
        break;
    }
    c.restore();
  }

  /* 탄약 측면 (구경별 실제 비례) */
  const CASE_DIMS = { // [케이스 길이mm, 림 지름mm, 탄자 노출mm]
    '.308 Winchester': [51, 12, 15],
    '.338 Lapua Magnum': [70, 15, 20],
    '.50 BMG': [99, 20, 31],
    '.408 CheyTac': [77, 16, 27],
  };
  function drawAmmoIcon(cv, ammo, scale = 1) {
    const c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    const [caseL, rim, bulletL] = CASE_DIMS[ammo.caliber] || [60, 14, 18];
    const pxPerMm = (W * 0.72) / 130 * scale; // .50 BMG(130mm 전장)를 기준 폭에 맞춤
    const cl = caseL * pxPerMm, bl = bulletL * pxPerMm, r = rim * pxPerMm / 2;
    const total = cl + bl;
    c.save();
    c.translate(W / 2 - total / 2, H / 2);
    // 케이스 (황동)
    const brass = c.createLinearGradient(0, -r, 0, r);
    brass.addColorStop(0, '#d9b878'); brass.addColorStop(0.45, '#a8863f');
    brass.addColorStop(0.6, '#c8a25c'); brass.addColorStop(1, '#7a5f2c');
    c.fillStyle = brass;
    c.beginPath();
    c.moveTo(0, -r); c.lineTo(cl * 0.72, -r);          // 몸통
    c.lineTo(cl * 0.86, -r * 0.55);                     // 숄더
    c.lineTo(cl, -r * 0.5);                             // 넥
    c.lineTo(cl, r * 0.5);
    c.lineTo(cl * 0.86, r * 0.55);
    c.lineTo(cl * 0.72, r);
    c.lineTo(0, r);
    c.closePath(); c.fill();
    // 림/추출홈
    c.fillRect(-2, -r, 3, r * 2);
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(2, -r * 0.92, 2.5, r * 1.84);
    // 탄자 (구리)
    const cu = c.createLinearGradient(0, -r * 0.5, 0, r * 0.5);
    cu.addColorStop(0, '#c67e4a'); cu.addColorStop(0.5, '#8c4d22'); cu.addColorStop(1, '#5f3315');
    c.fillStyle = cu;
    c.beginPath();
    c.moveTo(cl, -r * 0.5);
    c.quadraticCurveTo(cl + bl * 0.72, -r * 0.44, cl + bl, 0);  // 오자이브
    c.quadraticCurveTo(cl + bl * 0.72, r * 0.44, cl, r * 0.5);
    c.closePath(); c.fill();
    c.restore();
  }

  /* 총기 목록: 세로 리스트 — 이미지 + 이름만 */
  function buildMenu() {
    const rl = $('rifle-list');
    rl.innerHTML = '';
    for (const r of GameData.rifles) {
      const el = document.createElement('div');
      el.className = 'v-item';
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 92;
      el.appendChild(cv);
      el.insertAdjacentHTML('beforeend', `<h3>${r.name}</h3>`);
      drawRifleIcon(cv, r.id, 1.45);
      el.onclick = () => showRifleDetail(r);
      rl.appendChild(el);
    }
  }
  /* 총기 상세: 설명 + 레티클 선택 + 선택하기/돌아가기 */
  function showRifleDetail(r) {
    const pane = $('rifle-detail');
    pane.innerHTML = '';
    const cv = document.createElement('canvas');
    cv.width = 440; cv.height = 150;
    pane.appendChild(cv);
    pane.insertAdjacentHTML('beforeend',
      `<h3>${r.name}</h3><div class="sub">${r.caliber}</div>` +
      `<div class="desc">${r.desc}</div>` +
      `<div class="specs">총열 ${r.barrelMm} mm · 중량 ${r.weightKg} kg · 유효사거리 ~${r.effectiveRangeM.toLocaleString()} m</div>` +
      srcLine(r) +
      `<div class="ret-label">레티클 선택 <small>— 측거표 단위가 함께 바뀐다 (기본 Mil-Dot)</small></div>` +
      `<div class="ret-grid" id="ret-grid"></div>` +
      `<div class="detail-btns">
        <button class="btn-primary" id="rifle-pick">이 총기 선택 →</button>
        <button class="btn-back" id="rifle-back">← 돌아가기</button>
      </div>`);
    drawRifleIcon(cv, r.id, 2);
    // 레티클 카드 그리드
    const rg = $('ret-grid');
    for (const ret of RETICLES) {
      const card = document.createElement('div');
      card.className = 'ret-card' + (S.reticle === ret.id ? ' on' : '');
      card.dataset.ret = ret.id;
      const pcv = document.createElement('canvas');
      pcv.width = 96; pcv.height = 96;
      card.appendChild(pcv);
      card.insertAdjacentHTML('beforeend', `<div class="rname">${ret.name}</div>`);
      drawReticlePreview(pcv, ret.id);
      card.onclick = () => {
        S.reticle = ret.id;
        rg.querySelectorAll('.ret-card').forEach(x =>
          x.classList.toggle('on', x.dataset.ret === ret.id));
        saveSettings();
      };
      rg.appendChild(card);
    }
    $('rifle-pick').onclick = () => { S.rifle = r; showStep('ammo'); };
    $('rifle-back').onclick = () => showStep('rifle');
    showStep('rifleDetail');
  }
  /* 탄종 목록: 세로 리스트 — 좌측 정사각 이미지 + 우측 간략 설명 */
  function buildAmmoMenu() {
    const al = $('ammo-list');
    al.innerHTML = '';
    for (const id of S.rifle.ammoIds) {
      const a = GameData.getAmmo(id);
      const el = document.createElement('div');
      el.className = 'v-item ammo-row';
      const box = document.createElement('div');
      box.className = 'ammo-thumb';
      const cv = document.createElement('canvas');
      cv.width = 88; cv.height = 88;
      box.appendChild(cv);
      el.appendChild(box);
      el.insertAdjacentHTML('beforeend',
        `<div class="ammo-info"><h3>${a.name}</h3><div class="sub">${a.caliber} · ${a.bulletGr} gr · BC ${a.bc}</div>` +
        `<div class="brief">${a.brief || ''}</div></div>`);
      drawAmmoIcon(cv, a, 1.15);
      el.onclick = () => showAmmoDetail(a);
      al.appendChild(el);
    }
  }
  /* 탄종 상세: 선택 시 바로 임무 개시 */
  function showAmmoDetail(a) {
    const pane = $('ammo-detail');
    pane.innerHTML = '';
    const cv = document.createElement('canvas');
    cv.width = 440; cv.height = 130;
    pane.appendChild(cv);
    pane.insertAdjacentHTML('beforeend',
      `<h3>${a.name}</h3><div class="sub">${a.caliber}</div>` +
      `<div class="desc">${a.desc}</div>` +
      `<div class="specs">탄두 ${a.bulletGr} gr · BC(${a.dragModel}) ${a.bc} · 총구속도 ${fmt(a.mv, 0)} m/s · V₀ 편차 σ ${a.mvSd} m/s</div>` +
      srcLine(a) +
      `<div class="detail-btns">
        <button class="btn-primary" id="ammo-pick">이 탄약으로 임무 개시 →</button>
        <button class="btn-back" id="ammo-back">← 돌아가기</button>
      </div>`);
    drawAmmoIcon(cv, a, 1.6);
    $('ammo-pick').onclick = () => { S.ammo = a; startGame(); };
    $('ammo-back').onclick = () => showStep('ammo');
    showStep('ammoDetail');
  }
  /* 임무(맵) 목록 — 선택 흐름의 첫 단계 */
  function buildMissionMenu() {
    const ml = $('mission-list');
    ml.innerHTML = '';
    for (const m of GameData.missions) {
      const el = document.createElement('div');
      el.className = 'card';
      const cl = m.climate;
      const dists = m.anchors.map(a => a.dist);
      const dMin = Math.min(...dists), dMax = Math.max(...dists);
      el.innerHTML =
        `<h3>${m.name}</h3><div class="sub">교전 거리 ${dMin.toLocaleString()}~${dMax.toLocaleString()} m</div>` +
        `<div class="desc">${m.briefing}</div>` +
        `<div class="specs">기온 ${cl.tempC[0]}~${cl.tempC[1]}℃ · 바람 ${cl.windSpeed[0]}~${cl.windSpeed[1]} m/s · ` +
        `적 ${m.hostiles[0]}~${m.hostiles[1]}명` +
        (m.civilians[1] ? ` · 민간인 최대 ${m.civilians[1]}명` : '') +
        `<br>라운드 ${m.rounds ?? 5}회 × ${m.shotsPerRound ?? 3}발 · ` +
        `<span style="color:var(--warn)">거리·기상·상황 매판 랜덤</span>` +
        (m.env.earthCurvature ? ' · 곡률/코리올리 유효' : '') + `</div>`;
      el.onclick = () => { S.map = m; showStep('rifle'); };
      ml.appendChild(el);
    }
  }
  function showStep(step) {
    ['mission', 'rifle', 'rifleDetail', 'ammo', 'ammoDetail'].forEach(x =>
      $('step-' + x).classList.toggle('hidden', x !== step));
    if (step === 'ammo') buildAmmoMenu();
  }
  document.querySelectorAll('.btn-back[data-back]').forEach(b =>
    b.onclick = () => showStep(b.dataset.back));
  $('analysis-close').onclick = () => $('analysis').classList.add('hidden');
  $('btn-retry').onclick = () => { $('result').classList.add('hidden'); startGame(); };
  $('btn-menu').onclick = () => backToMenu();

  /* ---------------- 입력: 조준 방식 (마우스룩 / 드래그) ---------------- */
  // 'look'  — 클릭해 포인터 잠금 → 마우스 이동으로 조준 → 클릭으로 발사 (데스크톱 전용)
  // 'drag'  — 드래그해 조준 → 짧게 탭/클릭하면 발사 (포인터 잠금 불필요, 터치도 지원)
  function setControlMode(mode, announce = true) {
    if (S.controlMode === mode) return;
    S.controlMode = mode;
    if (mode === 'drag' && S.pointerLocked) document.exitPointerLock && document.exitPointerLock();
    updateHelpText();
    if (announce) setMsg(mode === 'drag' ? '조준 방식: 드래그 (짧게 클릭하면 발사)' : '조준 방식: 마우스룩 (클릭해 조준 잠금)', 3);
  }
  function updateHelpText() {
    $('hud-help').innerHTML = S.controlMode === 'drag'
      ? '드래그: 조준 · 짧게 클릭: 발사 · 노브 드래그/터치: 터렛 · 링(9~6시) 드래그/휠: 배율 · Shift: 숨 참기 · V: 레티클 색상 · M: 메뉴 · A: 명중률 분석'
      : '클릭: 조준 잠금/발사 · ↑↓←→: 터렛 · 링(9~6시) 드래그/휠: 배율 · Shift: 숨 참기 · V: 레티클 색상 · M: 메뉴 · A: 명중률 분석';
    const lk = $('tgl-look'); if (lk) lk.checked = S.controlMode === 'look';
  }

  // ── look 모드: 클릭 → 포인터 잠금 / 잠긴 상태에서 클릭 → 발사 ──
  canvas.addEventListener('click', () => {
    if (S._uiClick) { S._uiClick = false; return; }
    if (S.phase !== 'play' || S.controlMode !== 'look') return;
    audio() && AC.state === 'suspended' && AC.resume();
    startWindAmbience();
    if (!S.pointerLocked) {
      canvas.requestPointerLock && canvas.requestPointerLock();
    } else {
      fire();
    }
  });
  document.addEventListener('pointerlockchange', () => {
    S.pointerLocked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', e => {
    if (S.phase !== 'play' || S.controlMode !== 'look' || !S.pointerLocked) return;
    const sens = 0.045 * (25 / S.mag) / (S.stageScale || 1);
    const L = aimLimits(S.mag);
    S.aim.yaw = clamp(S.aim.yaw + e.movementX * sens, L.yawMin, L.yawMax);
    S.aim.pitch = clamp(S.aim.pitch - e.movementY * sens, L.pitMin, L.pitMax);
  });

  /* ── 스코프 위 직접 조작 영역 (논리 좌표 1440×900 기준) ──
   *  상단 엘리베이션 노브: 드래그(좌우) 또는 중앙 기준 좌/우 터치
   *  우측 윈디지 노브: 드래그(상하) 또는 중앙 기준 상/하 터치
   *  스코프 링 9시~6시 원호: 드래그해 배율 조정 (배율 링) */
  const UI_KNOB_E = { x0: 560, x1: 880, y0: 0, y1: 92 };
  const UI_KNOB_W = { x0: 1080, x1: 1220, y0: 300, y1: 600 };
  const inRect = (p, r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * BASE_W, y: (e.clientY - r.top) / r.height * BASE_H };
  }
  /* 배율 링 히트 판정: 스코프 중심 기준 극좌표 (r은 스코프 반지름 배수) */
  function zoomRingHit(p) {
    const R = Math.min(BASE_W, BASE_H) * 0.44;
    const dx = p.x - BASE_W / 2, dy = p.y - BASE_H / 2;
    let a = Math.atan2(dy, dx);
    if (a < 0) a += TAU; // 9시 바로 위 터치(−π 근처)도 π+ε로 취급
    return { r: Math.hypot(dx, dy) / R, a };
  }
  function setMagFromRing(a) {
    const next = magFromRingAngle(a);
    if (next !== S.mag) { S.mag = next; playClick(); }
  }
  const KNOB_STEP = 13; // 논리 px 당 1클릭
  let uiDrag = null; // {kind, id, sx, sy, lx, ly, acc, moved}
  function uiPointerDown(e, p) {
    const zr = zoomRingHit(p);
    if (inRect(p, UI_KNOB_E)) {
      uiDrag = { kind: 'elev', id: e.pointerId, sx: p.x, sy: p.y, lx: p.x, ly: p.y, acc: 0, moved: false };
    } else if (inRect(p, UI_KNOB_W)) {
      uiDrag = { kind: 'wind', id: e.pointerId, sx: p.x, sy: p.y, lx: p.x, ly: p.y, acc: 0, moved: false };
    } else if (zr.r >= 0.97 && zr.r <= 1.55 && zr.a >= ZR_A0 - 0.12 && zr.a <= ZR_A1 + 0.12) {
      setMagFromRing(zr.a);
      uiDrag = { kind: 'zoomring', id: e.pointerId, sx: p.x, sy: p.y, moved: false };
    } else return false;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    S.lastHudUpdate = 0;
    return true;
  }
  function uiPointerMove(e, p) {
    const u = uiDrag;
    if (Math.hypot(p.x - u.sx, p.y - u.sy) > 8) u.moved = true;
    if (u.kind === 'elev') {
      u.acc += p.x - u.lx; u.lx = p.x;
      while (u.acc >= KNOB_STEP) { S.dial.elev++; playClick(); u.acc -= KNOB_STEP; }
      while (u.acc <= -KNOB_STEP) { S.dial.elev--; playClick(); u.acc += KNOB_STEP; }
    } else if (u.kind === 'wind') {
      u.acc += u.ly - p.y; u.ly = p.y;
      while (u.acc >= KNOB_STEP) { S.dial.wind++; playClick(); u.acc -= KNOB_STEP; }
      while (u.acc <= -KNOB_STEP) { S.dial.wind--; playClick(); u.acc += KNOB_STEP; }
    } else if (u.kind === 'zoomring') {
      setMagFromRing(zoomRingHit(p).a);
    }
    S.lastHudUpdate = 0;
  }
  function uiPointerUp(p) {
    const u = uiDrag;
    uiDrag = null;
    S._uiClick = true; // look 모드 click 발사 방지
    if (u.moved) return;
    // 탭: 중앙 기준선 기준 방향으로 1클릭
    if (u.kind === 'elev') { p.x >= (UI_KNOB_E.x0 + UI_KNOB_E.x1) / 2 ? S.dial.elev++ : S.dial.elev--; playClick(); }
    if (u.kind === 'wind') { p.y <= (UI_KNOB_W.y0 + UI_KNOB_W.y1) / 2 ? S.dial.wind++ : S.dial.wind--; playClick(); }
    S.lastHudUpdate = 0;
  }

  // ── 조준: drag 모드(기본) — 드래그로 조준, 이동 없는 탭은 발사 ──
  let dragState = null;
  const DRAG_THRESHOLD = 6;
  canvas.addEventListener('pointerdown', e => {
    if (S.phase !== 'play') return;
    audio() && AC.state === 'suspended' && AC.resume();
    startWindAmbience();
    const p = toLogical(e);
    if (!S.pointerLocked && uiPointerDown(e, p)) return;
    if (S.controlMode !== 'drag') return;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    dragState = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (S.phase !== 'play') return;
    if (uiDrag && e.pointerId === uiDrag.id) { uiPointerMove(e, toLogical(e)); return; }
    if (S.controlMode !== 'drag' || !dragState || e.pointerId !== dragState.id) return;
    const dx = e.clientX - dragState.lastX, dy = e.clientY - dragState.lastY;
    dragState.lastX = e.clientX; dragState.lastY = e.clientY;
    if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > DRAG_THRESHOLD) dragState.moved = true;
    const sens = 0.045 * (25 / S.mag) / (S.stageScale || 1);
    const L = aimLimits(S.mag);
    S.aim.yaw = clamp(S.aim.yaw + dx * sens, L.yawMin, L.yawMax);
    S.aim.pitch = clamp(S.aim.pitch - dy * sens, L.pitMin, L.pitMax);
  });
  canvas.addEventListener('pointerup', e => {
    if (uiDrag && e.pointerId === uiDrag.id) { uiPointerUp(toLogical(e)); return; }
    if (S.controlMode !== 'drag' || !dragState || e.pointerId !== dragState.id) return;
    const wasTap = !dragState.moved;
    dragState = null;
    // 세로 모바일은 방아쇠 슬라이더로만 격발 (오발 방지)
    if (S.phase === 'play' && wasTap && !$('game').classList.contains('mobile-sq')) fire();
  });
  canvas.addEventListener('pointercancel', () => { dragState = null; uiDrag = null; });
  window.addEventListener('wheel', e => {
    if (S.phase !== 'play') return;
    S.mag = clamp(S.mag - Math.sign(e.deltaY) * 1, S.magMin || 5, 25);
  }, { passive: true });

  window.addEventListener('keydown', e => {
    if (S.phase !== 'play') return;
    switch (e.code) {
      case 'ArrowUp': S.dial.elev++; playClick(); e.preventDefault(); break;
      case 'ArrowDown': S.dial.elev--; playClick(); e.preventDefault(); break;
      case 'ArrowRight': S.dial.wind++; playClick(); e.preventDefault(); break;
      case 'ArrowLeft': S.dial.wind--; playClick(); e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': S.holdingBreath = true; break;
      case 'KeyM': backToMenu(); break;
      case 'KeyA': runAnalysis(); break;
      case 'KeyC': setControlMode(S.controlMode === 'drag' ? 'look' : 'drag'); break;
      case 'KeyV': cycleRetStyle(); break;  // 데스크톱은 플레이 중 설정에 못 들어간다
    }
    S.lastHudUpdate = 0;
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.holdingBreath = false;
  });

  /* ---------------- 상단 토글 스위치 ---------------- */
  $('tgl-hl').addEventListener('change', e => {
    S.assistHL = e.target.checked;
    S._dopeHint = null; // 다음 HUD 갱신 때 재렌더
    renderBallistic();
    saveSettings();
  });
  $('tgl-look').addEventListener('change', e => {
    setControlMode(e.target.checked ? 'look' : 'drag');
    saveSettings();
  });

  /* ================================================================
   * 앱 셸: 하단 내비(시뮬레이터/클래스룸/설정) + 모바일 크롬 관리
   *  - 모바일 세로 플레이: 상단 정보바 + 스코프 + 컨트롤 패널 + 내비
   *  - 모바일 가로 플레이: 기존 숨참기/발사 플로팅 버튼
   * ================================================================ */
  const coarsePointer = window.matchMedia && matchMedia('(pointer: coarse)');
  const isCoarse = () => coarsePointer && coarsePointer.matches;
  const isPortrait = () => window.innerHeight > window.innerWidth * 1.05;

  function updateTouchBar() { // (이름 유지 — 크롬 전체 관리)
    const coarse = isCoarse();
    const portrait = isPortrait();
    const playing = S.phase === 'play';
    const mp = coarse && portrait;                 // 모바일 세로
    $('touch-bar').classList.toggle('hidden', !(playing && coarse && !portrait));
    $('mobile-top').classList.toggle('hidden', !(playing && mp));
    $('ctl-panel').classList.toggle('hidden', !(playing && mp));
    // 내비: 메뉴/클래스룸/설정 화면에선 항상, 플레이 중엔 모바일 세로에서만
    const navShow = !playing || mp;
    $('mnav').classList.toggle('hidden', !navShow);
    document.body.classList.toggle('has-nav', navShow);
    $('tgl-look-row').classList.toggle('hidden', !!coarse);
    const slr = $('set-look-row'); if (slr) slr.classList.toggle('hidden', !!coarse);
  }

  /* ── 하단 내비 탭 전환 ── */
  function switchTab(tab) {
    S.navTab = tab;
    document.querySelectorAll('#mnav .mnav-btn').forEach(b =>
      b.classList.toggle('on', b.dataset.tab === tab));
    $('classroom').classList.toggle('hidden', tab !== 'classroom');
    $('settings').classList.toggle('hidden', tab !== 'settings');
    if (tab !== 'classroom') $('lesson-view').classList.add('hidden');
  }
  document.querySelectorAll('#mnav .mnav-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  /* ── 클래스룸: 레슨 목록 + 뷰어 (전부 무료) ── */
  function drawDiagramTo(cv, key) {
    const fn = Diagrams[key];
    if (!fn) return;
    fn(cv.getContext('2d'), cv.width, cv.height);
  }
  function buildClassroom() {
    const list = $('lesson-list');
    list.innerHTML = '';
    for (const L of Lessons) {
      const el = document.createElement('div');
      el.className = 'lesson-card';
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 340;
      el.appendChild(cv);
      el.insertAdjacentHTML('beforeend', `<div class="lc-title">${L.title}</div>`);
      drawDiagramTo(cv, L.thumb);
      el.onclick = () => openLesson(L);
      list.appendChild(el);
    }
  }
  function openLesson(L) {
    $('lesson-title').textContent = L.title;
    const body = $('lesson-body');
    body.innerHTML = '';
    for (const sec of L.sections) {
      const div = document.createElement('div');
      div.className = 'lesson-sec';
      if (sec.d) {
        const cv = document.createElement('canvas');
        cv.width = 640; cv.height = 320;
        div.appendChild(cv);
        drawDiagramTo(cv, sec.d);
      }
      div.insertAdjacentHTML('beforeend', `<h3>${sec.h}</h3><p>${sec.b}</p>`);
      body.appendChild(div);
    }
    $('classroom').classList.add('hidden');
    $('lesson-view').classList.remove('hidden');
    $('lesson-view').scrollTop = 0;
  }
  const backToClassroom = () => {
    $('lesson-view').classList.add('hidden');
    $('classroom').classList.remove('hidden');
  };
  $('lesson-back').onclick = backToClassroom;
  $('lesson-back2').onclick = backToClassroom;

  /* ── 설정 ── */
  /* ── 설정 저장 ──
   * 새로고침해도 선택이 유지되도록 localStorage에 보관한다.
   * 사생활 보호 모드 등에서 접근 자체가 예외를 던질 수 있어 전부 try로 감싼다. */
  const LS_KEY = 'lmsniper.settings.v1';
  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        retStyle: S.retStyle, reticle: S.reticle, assistHL: S.assistHL,
        controlMode: S.controlMode, muted: S.muted,
      }));
    } catch (e) { /* 저장 불가 — 이번 세션에만 적용된다 */ }
  }
  function loadSettings() {
    let o;
    try { o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return; }
    if (!o) return;
    // 저장된 값이 유효할 때만 반영 (스타일 목록이 바뀌어도 안전하게)
    if (RET_STYLES.some(v => v.id === o.retStyle)) S.retStyle = o.retStyle;
    if (RETICLES.some(r => r.id === o.reticle)) S.reticle = o.reticle;
    if (typeof o.assistHL === 'boolean') S.assistHL = o.assistHL;
    if (o.controlMode === 'drag' || o.controlMode === 'look') S.controlMode = o.controlMode;
    if (typeof o.muted === 'boolean') S.muted = o.muted;
  }

  /* ── 레티클 색상 세그먼트 (설정 + 상단 HUD 공용) ── */
  function buildVisSeg(host) {
    if (!host) return;
    host.innerHTML = RET_STYLES.map(v =>
      `<button type="button" class="seg-btn" data-v="${v.id}">${v.name}</button>`).join('');
  }
  const cycleRetStyle = () => {
    const i = RET_STYLES.findIndex(v => v.id === S.retStyle);
    setRetStyle(RET_STYLES[(i + 1) % RET_STYLES.length].id, true);
  };
  function setRetStyle(id, announce) {
    if (!RET_STYLES.some(v => v.id === id)) return;
    S.retStyle = id;
    retLayers.clear();                    // 스타일이 바뀌면 구워둔 레이어를 버린다
    syncSettingsUI();
    // 총기 상세가 열려 있으면 카드 미리보기도 새 스타일로 다시 그린다
    document.querySelectorAll('#ret-grid .ret-card').forEach(c => {
      const cv = c.querySelector('canvas');
      if (cv) drawReticlePreview(cv, c.dataset.ret);
    });
    if (announce) setMsg(`레티클 색상: ${retStyleDef(id).name}`, 2);
    saveSettings();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (b) setRetStyle(b.dataset.v);
  });

  function syncSettingsUI() {
    $('set-hl').checked = S.assistHL;
    $('tgl-hl').checked = S.assistHL;
    const sl = $('set-look'); if (sl) sl.checked = S.controlMode === 'look';
    $('set-sound').checked = !S.muted;
    document.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('on', b.dataset.v === S.retStyle));
    const cyc = $('hud-retcycle');
    if (cyc) cyc.textContent = `레티클: ${retStyleDef(S.retStyle).name} ▸`;
  }
  $('hud-retcycle').addEventListener('click', cycleRetStyle);
  $('set-hl').addEventListener('change', e => {
    S.assistHL = e.target.checked; S._dopeHint = null; syncSettingsUI(); saveSettings();
  });
  $('set-look').addEventListener('change', e => {
    setControlMode(e.target.checked ? 'look' : 'drag'); saveSettings();
  });
  $('set-sound').addEventListener('change', e => {
    S.muted = !e.target.checked;
    if (windAmb && AC) windAmb.gain.gain.setTargetAtTime(0, AC.currentTime, 0.1);
    saveSettings();
  });

  /* ── 가로 모바일: 숨참기/발사 플로팅 버튼 (기존 유지) ── */
  {
    const bBtn = $('btn-breath');
    let holdPt = null;
    bBtn.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (S.phase !== 'play') return;
      audio() && AC.state === 'suspended' && AC.resume();
      startWindAmbience();
      bBtn.setPointerCapture && bBtn.setPointerCapture(e.pointerId);
      S.fireHold = true;
      S.holdingBreath = true;
      bBtn.classList.add('on');
      holdPt = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    bBtn.addEventListener('pointermove', e => {
      if (!holdPt || e.pointerId !== holdPt.id || S.phase !== 'play') return;
      const sens = 0.045 * (25 / S.mag) / (S.stageScale || 1) * 0.35;
      const L = aimLimits(S.mag);
      S.aim.yaw = clamp(S.aim.yaw + (e.clientX - holdPt.x) * sens, L.yawMin, L.yawMax);
      S.aim.pitch = clamp(S.aim.pitch - (e.clientY - holdPt.y) * sens, L.pitMin, L.pitMax);
      holdPt.x = e.clientX; holdPt.y = e.clientY;
    });
    const releaseBreath = e => {
      if (!holdPt || (e && e.pointerId !== holdPt.id)) return;
      holdPt = null;
      S.fireHold = false;
      S.holdingBreath = false;
      bBtn.classList.remove('on');
    };
    bBtn.addEventListener('pointerup', releaseBreath);
    bBtn.addEventListener('pointercancel', releaseBreath);
    bBtn.addEventListener('contextmenu', e => e.preventDefault());

    const fBtn = $('btn-fire');
    fBtn.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (S.phase !== 'play') return;
      audio() && AC.state === 'suspended' && AC.resume();
      startWindAmbience();
      fire();
    });
    fBtn.addEventListener('contextmenu', e => e.preventDefault());

    $('mt-menu').addEventListener('click', () => backToMenu());
  }

  /* ================================================================
   * 세로형 컨트롤 패널 (레퍼런스 스타일)
   * ================================================================ */
  {
    // 탭 전환
    document.querySelectorAll('.cp-tab').forEach(t =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.cp-tab').forEach(x => x.classList.toggle('on', x === t));
        ['act', 'bal', 'siz'].forEach(k =>
          $('cp-' + k).classList.toggle('hidden', k !== t.dataset.cp));
        S.lastHudUpdate = 0; // 탄도 표 등 즉시 갱신
      }));

    // 숨참기 (패널)
    const pb = $('p-breath');
    pb.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (S.phase !== 'play') return;
      audio() && AC.state === 'suspended' && AC.resume();
      startWindAmbience();
      pb.setPointerCapture && pb.setPointerCapture(e.pointerId);
      S.fireHold = true;
      S.holdingBreath = true;
      pb.classList.add('on');
    });
    const pbEnd = () => { S.fireHold = false; S.holdingBreath = false; pb.classList.remove('on'); };
    pb.addEventListener('pointerup', pbEnd);
    pb.addEventListener('pointercancel', pbEnd);
    pb.addEventListener('contextmenu', e => e.preventDefault());

    // 방아쇠 슬라이더: 아래로 당겨 빨간 선을 넘기면 격발
    const tr = $('p-trigger'), th = $('pt-handle');
    let trDrag = null;
    const setHandle = frac => { // 0(위) ~ 1(끝)
      const r = tr.getBoundingClientRect();
      const maxTop = r.height * 0.62 - 6;
      th.style.top = `${6 + frac * maxTop}px`;
    };
    tr.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (S.phase !== 'play') return;
      audio() && AC.state === 'suspended' && AC.resume();
      startWindAmbience();
      tr.setPointerCapture && tr.setPointerCapture(e.pointerId);
      trDrag = { id: e.pointerId, startY: e.clientY, fired: false };
      th.classList.add('armed');
    });
    tr.addEventListener('pointermove', e => {
      if (!trDrag || e.pointerId !== trDrag.id) return;
      const r = tr.getBoundingClientRect();
      const frac = clamp((e.clientY - trDrag.startY) / (r.height * 0.62), 0, 1);
      setHandle(frac);
      // 핸들 하단이 빨간 선(68%)을 넘는 순간 격발
      if (!trDrag.fired && frac >= 0.92) {
        trDrag.fired = true;
        if (navigator.vibrate) navigator.vibrate(30);
        fire();
      }
    });
    const trEnd = e => {
      if (!trDrag || (e && e.pointerId !== trDrag.id)) return;
      trDrag = null;
      th.classList.remove('armed');
      setHandle(0);
    };
    tr.addEventListener('pointerup', trEnd);
    tr.addEventListener('pointercancel', trEnd);

  }

  /* 측거표 (LRS 스타일): 거리별 표적 크기 — 선택 레티클 단위(mrad/MOA)로 표시 */
  function buildSizes() {
    const unit = reticleUnit();
    const k = unit === 'moa' ? 3.437747 : 1; // mrad → MOA
    const u = unit === 'moa' ? 'MOA' : 'mrad';
    const { lo, hi, step } = tableRange();
    const wh = (wcm, hcm, d) =>
      `${(wcm * 10 / d * k).toFixed(1)}×${(hcm * 10 / d * k).toFixed(1)}`;
    let html =
      `<div class="tbl-head">측거표 — ${reticleName()} [${u}]</div>` +
      `<table><tr>` +
      `<th>DIST<br><small>m</small></th>` +
      `<th>BODY<br><small>50×80cm ${u}</small></th>` +
      `<th>FULL BODY<br><small>50×180cm ${u}</small></th>` +
      `<th>CIRCLE<br><small>60×60cm ${u}</small></th>` +
      `<th>SQUARE<br><small>100×100cm ${u}</small></th></tr>`;
    for (let d = lo; d <= hi; d += step) {
      html += `<tr><td>${d}</td><td>${wh(50, 80, d)}</td><td>${wh(50, 180, d)}</td>` +
        `<td>${wh(60, 60, d)}</td><td>${wh(100, 100, d)}</td></tr>`;
    }
    html += `</table><div class="note2">거리 = 실제 크기 ÷ 측정 ${u} × ${unit === 'moa' ? '3438' : '1000'} — 레티클로 표적을 재서 거리를 역산하라.</div>`;
    $('sizes-table').innerHTML = html;
  }

  /* ---------------- 메인 루프 ---------------- */
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }
  window.__lm = S;
  loadSettings();          // 저장된 설정을 먼저 복원한 뒤 메뉴/UI를 만든다
  buildMissionMenu();
  buildMenu();
  buildClassroom();
  buildVisSeg($('set-retstyle'));
  syncSettingsUI();
  updateTouchBar();
  window.addEventListener('resize', updateTouchBar);
  loop();
})();
