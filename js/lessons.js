/* ============================================================
 * lessons.js — 클래스룸: 레슨 데이터 + 절차적 다이어그램
 * 레퍼런스 앱의 "이미지 + 제목 + 본문" 스크롤 레슨 구조를 따르되,
 * 이미지는 전부 캔버스로 자체 생성한다. 전 레슨 무료 개방.
 * ============================================================ */
'use strict';

const Diagrams = (() => {
  const C = {
    bg: '#0f1511', panel: '#16201a', line: '#33463a', txt: '#cfe3d4',
    dim: '#7d9484', accent: '#8fd14f', warn: '#e0a03c', bad: '#e05c4a',
    blue: '#4fb7d1', paper: '#e8e2d2', ink: '#141517',
  };
  function base(x, w, h) {
    x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
    x.strokeStyle = C.line; x.lineWidth = 1;
    x.strokeRect(0.5, 0.5, w - 1, h - 1);
    x.textBaseline = 'middle';
  }
  const font = (x, s, wgt = 400) => { x.font = `${wgt} ${s}px "Pretendard","Noto Sans KR",sans-serif`; };

  /* 화면 구성 개요 */
  function layout(x, w, h) {
    base(x, w, h);
    const s = Math.min(w / 360, h / 240);
    x.save(); x.translate(w / 2 - 180 * s, h / 2 - 120 * s); x.scale(s, s);
    // 스코프 영역
    x.fillStyle = C.panel; x.fillRect(20, 14, 200, 200);
    x.strokeStyle = C.dim; x.beginPath(); x.arc(120, 114, 86, 0, 7); x.stroke();
    x.strokeStyle = C.accent; x.lineWidth = 1;
    x.beginPath(); x.moveTo(120, 40); x.lineTo(120, 188); x.moveTo(46, 114); x.lineTo(194, 114); x.stroke();
    // 노브 표시
    x.fillStyle = C.warn;
    x.fillRect(95, 6, 50, 10);   // 상단 엘리베이션
    x.fillRect(224, 90, 10, 48); // 우측 윈디지
    x.fillRect(6, 90, 10, 48);   // 좌측 배율 바
    font(x, 12); x.fillStyle = C.txt; x.textAlign = 'left';
    x.fillText('① 고각 노브', 250, 20);
    x.fillText('② 윈디지 노브', 250, 44);
    x.fillText('③ 배율 바', 250, 68);
    x.fillText('④ 조준: 스코프 드래그', 250, 92);
    x.fillStyle = C.dim;
    x.fillText('하단 패널: 조작·탄도·측거표', 250, 140);
    x.fillStyle = C.warn;
    x.beginPath(); x.moveTo(244, 20); x.lineTo(146, 12); x.stroke();
    x.restore();
  }

  /* 낙차 곡선 */
  function drop(x, w, h) {
    base(x, w, h);
    const m = 34, gw = w - m * 2, gh = h - m * 2;
    x.strokeStyle = C.line;
    x.beginPath(); x.moveTo(m, m); x.lineTo(m, h - m); x.lineTo(w - m, h - m); x.stroke();
    // 조준선 (LOS)
    x.strokeStyle = C.dim; x.setLineDash([5, 4]);
    x.beginPath(); x.moveTo(m, m + gh * 0.25); x.lineTo(w - m, m + gh * 0.25); x.stroke();
    x.setLineDash([]);
    // 탄도 곡선
    x.strokeStyle = C.accent; x.lineWidth = 2;
    x.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const px = m + gw * t;
      const py = m + gh * 0.25 - gh * (0.55 * t - 0.62 * t * t);
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.stroke(); x.lineWidth = 1;
    // 낙차 화살표
    const tx = m + gw * 0.86, top = m + gh * 0.25;
    const ty = top - gh * (0.55 * 0.86 - 0.62 * 0.86 * 0.86);
    x.strokeStyle = C.bad;
    x.beginPath(); x.moveTo(tx, top); x.lineTo(tx, ty); x.stroke();
    x.fillStyle = C.bad; font(x, 12); x.textAlign = 'left';
    x.fillText('낙차', tx + 8, (top + ty) / 2);
    x.fillStyle = C.dim; x.textAlign = 'center';
    x.fillText('총구', m, h - m + 14);
    x.fillText('영점(100m)', m + gw * 0.28, h - m + 14);
    x.fillText('표적', w - m, h - m + 14);
    x.fillStyle = C.txt; x.textAlign = 'left';
    x.fillText('조준선', m + 6, m + gh * 0.25 - 10);
  }

  /* 바람 시계 (탑다운) */
  function windclock(x, w, h) {
    base(x, w, h);
    const cx = w * 0.34, cy = h / 2, R = Math.min(w, h) * 0.36;
    x.strokeStyle = C.line;
    x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke();
    font(x, 11); x.fillStyle = C.dim; x.textAlign = 'center';
    x.fillText('12시(표적)', cx, cy - R - 12);
    x.fillText('6시(등뒤)', cx, cy + R + 12);
    x.fillText('9시', cx - R - 16, cy); x.fillText('3시', cx + R + 16, cy);
    // 사수→표적 축
    x.strokeStyle = C.dim; x.setLineDash([4, 4]);
    x.beginPath(); x.moveTo(cx, cy + R); x.lineTo(cx, cy - R); x.stroke(); x.setLineDash([]);
    // full value 바람 (3시 → 9시)
    x.strokeStyle = C.warn; x.lineWidth = 2.5;
    x.beginPath(); x.moveTo(cx + R * 0.9, cy); x.lineTo(cx - R * 0.55, cy); x.stroke();
    x.fillStyle = C.warn;
    x.beginPath(); x.moveTo(cx - R * 0.65, cy); x.lineTo(cx - R * 0.5, cy - 7); x.lineTo(cx - R * 0.5, cy + 7); x.fill();
    x.lineWidth = 1;
    x.fillStyle = C.txt; x.textAlign = 'left'; font(x, 12.5);
    const lx = w * 0.66;
    x.fillText('3·9시 바람 = full value', lx, cy - 26);
    x.fillStyle = C.dim;
    x.fillText('1·5·7·11시 ≈ half value', lx, cy);
    x.fillText('12·6시 = 편류 거의 없음', lx, cy + 26);
  }

  /* 공기 밀도 요인 */
  function air(x, w, h) {
    base(x, w, h);
    const rows = [
      ['기온 ↑', '밀도 ↓ → 낙차 감소', C.bad],
      ['고도 ↑', '기압·밀도 ↓ → 낙차 감소', C.warn],
      ['습도 ↑', '밀도 소폭 ↓ (영향 작음)', C.blue],
    ];
    font(x, 13); x.textAlign = 'left';
    rows.forEach((r, i) => {
      const y = h * (0.25 + i * 0.25);
      x.fillStyle = r[2]; x.fillRect(24, y - 9, 8, 18);
      x.fillStyle = C.txt; x.fillText(r[0], 44, y);
      x.fillStyle = C.dim; x.fillText(r[1], w * 0.34, y);
    });
  }

  /* 밀 측거 브래킷 */
  function ranging(x, w, h) {
    base(x, w, h);
    const cx = w * 0.36, cy = h / 2;
    x.strokeStyle = C.txt;
    x.beginPath(); x.moveTo(cx - 90, cy); x.lineTo(cx + 90, cy); x.moveTo(cx, cy - 74); x.lineTo(cx, cy + 74); x.stroke();
    for (let m2 = -3; m2 <= 3; m2++) {
      if (!m2) continue;
      x.beginPath(); x.moveTo(cx + m2 * 26, cy - 5); x.lineTo(cx + m2 * 26, cy + 5);
      x.moveTo(cx - 5, cy + m2 * 22); x.lineTo(cx + 5, cy + m2 * 22); x.stroke();
    }
    // 표적 실루엣 (1.8 m = 2 mil 예시)
    x.fillStyle = C.ink;
    x.fillRect(cx + 18, cy - 44, 18, 44);
    x.beginPath(); x.arc(cx + 27, cy - 50, 7, 0, 7); x.fill();
    x.strokeStyle = C.accent;
    x.beginPath(); x.moveTo(cx + 48, cy - 57); x.lineTo(cx + 48, cy); x.stroke();
    x.fillStyle = C.accent; font(x, 11.5); x.textAlign = 'left';
    x.fillText('≈ 2.6 mil', cx + 54, cy - 28);
    x.fillStyle = C.txt; font(x, 13.5);
    x.fillText('거리 = 크기(m) ÷ mil × 1000', w * 0.58, h * 0.32);
    x.fillStyle = C.dim; font(x, 12.5);
    x.fillText('1.8 m ÷ 2.6 mil × 1000', w * 0.58, h * 0.52);
    x.fillText('≈ 692 m', w * 0.58, h * 0.66);
  }

  /* 표적지 존 */
  function zones(x, w, h) {
    base(x, w, h);
    const k = h * 0.42, cx = w * 0.3, feet = h * 0.88;
    const Y = m2 => feet - m2 * k / 1.0;
    x.fillStyle = C.paper; x.fillRect(cx - 0.36 * k, feet - 1.84 * k, 0.72 * k, 1.8 * k);
    x.fillStyle = C.ink;
    x.fillRect(cx - 0.2 * k, feet - 1.6 * k, 0.4 * k, 1.55 * k);
    x.beginPath(); x.arc(cx, feet - 1.68 * k, 0.12 * k, 0, 7); x.fill();
    x.strokeStyle = '#fff';
    [[0.10, 0.17], [0.17, 0.29], [0.245, 0.42]].forEach(([rw, rh]) => {
      x.beginPath(); x.ellipse(cx, feet - 1.3 * k, rw * k, rh * k, 0, 0, 7); x.stroke();
    });
    x.strokeStyle = C.bad;
    x.beginPath(); x.ellipse(cx, feet - 1.3 * k, 0.05 * k, 0.09 * k, 0, 0, 7); x.stroke();
    font(x, 12.5); x.textAlign = 'left';
    const L = [['머리 10점 (+2 보너스)', 1.68, C.bad], ['흉부 9점 / X링', 1.3, C.accent],
      ['복부 7점', 1.0, C.txt], ['하지 5점', 0.5, C.dim]];
    L.forEach(([t, m2, c]) => {
      x.fillStyle = c; x.fillText(t, w * 0.52, feet - m2 * k);
      x.strokeStyle = C.line;
      x.beginPath(); x.moveTo(w * 0.5, feet - m2 * k); x.lineTo(cx + 0.3 * k, feet - m2 * k); x.stroke();
    });
  }

  /* 탄착군 / CEP */
  function cep(x, w, h) {
    base(x, w, h);
    const cx = w * 0.34, cy = h / 2;
    x.strokeStyle = C.line;
    x.beginPath(); x.moveTo(cx - 80, cy); x.lineTo(cx + 80, cy); x.moveTo(cx, cy - 70); x.lineTo(cx, cy + 70); x.stroke();
    let sx = 12345;
    const rnd = () => { sx ^= sx << 13; sx ^= sx >>> 17; sx ^= sx << 5; return ((sx >>> 0) / 4294967296 - 0.5); };
    x.fillStyle = 'rgba(90,160,220,0.8)';
    for (let i = 0; i < 46; i++) {
      const dx = (rnd() + rnd() + rnd()) * 42, dy = (rnd() + rnd() + rnd()) * 34;
      x.beginPath(); x.arc(cx + dx, cy + dy, 2, 0, 7); x.fill();
    }
    x.strokeStyle = C.accent; x.lineWidth = 1.6;
    x.beginPath(); x.arc(cx, cy, 40, 0, 7); x.stroke(); x.lineWidth = 1;
    x.fillStyle = C.accent; font(x, 12); x.textAlign = 'left';
    x.fillText('CEP: 탄착 50%가 드는 원', w * 0.58, h * 0.3);
    x.fillStyle = C.txt;
    x.fillText('REP: 수직 공산오차', w * 0.58, h * 0.5);
    x.fillText('DEP: 수평 공산오차', w * 0.58, h * 0.66);
  }

  /* 코리올리 */
  function coriolis(x, w, h) {
    base(x, w, h);
    const cx = w * 0.3, cy = h / 2, R = Math.min(w, h) * 0.32;
    x.strokeStyle = C.blue;
    x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke();
    x.strokeStyle = C.dim; x.setLineDash([3, 3]);
    x.beginPath(); x.ellipse(cx, cy, R, R * 0.32, 0, 0, 7); x.stroke(); x.setLineDash([]);
    x.strokeStyle = C.warn; x.lineWidth = 2;
    x.beginPath(); x.arc(cx, cy - R - 8, 14, Math.PI * 0.2, Math.PI * 0.9); x.stroke();
    x.fillStyle = C.warn;
    x.beginPath(); x.moveTo(cx - 15, cy - R - 14); x.lineTo(cx - 4, cy - R - 18); x.lineTo(cx - 10, cy - R - 5); x.fill();
    x.lineWidth = 1;
    font(x, 12.5); x.textAlign = 'left';
    x.fillStyle = C.txt;
    x.fillText('지구 자전 → 탄이 미세하게 휨', w * 0.52, h * 0.3);
    x.fillStyle = C.dim;
    x.fillText('북반구: 오른쪽 편향', w * 0.52, h * 0.48);
    x.fillText('동/서 사격: 상하 편차(에트뵈시)', w * 0.52, h * 0.62);
    x.fillStyle = C.warn;
    x.fillText('1km 이상에서 무시 불가', w * 0.52, h * 0.78);
  }

  /* 교전 수칙: 적 vs 민간인 */
  function roe(x, w, h) {
    base(x, w, h);
    const k = h * 0.36, feet = h * 0.8;
    const sheet = (cx, ink, hands) => {
      x.fillStyle = C.paper; x.fillRect(cx - 0.36 * k, feet - 1.84 * k, 0.72 * k, 1.8 * k);
      x.fillStyle = ink;
      x.fillRect(cx - 0.18 * k, feet - 1.55 * k, 0.36 * k, 1.5 * k);
      x.beginPath(); x.arc(cx, feet - 1.64 * k, 0.11 * k, 0, 7); x.fill();
      if (hands) {
        x.save(); x.strokeStyle = ink; x.lineWidth = 0.08 * k; x.lineCap = 'round';
        x.beginPath();
        x.moveTo(cx - 0.24 * k, feet - 1.3 * k); x.lineTo(cx - 0.36 * k, feet - 1.72 * k);
        x.moveTo(cx + 0.24 * k, feet - 1.3 * k); x.lineTo(cx + 0.36 * k, feet - 1.72 * k);
        x.stroke(); x.restore();
      } else {
        x.save(); x.strokeStyle = '#0a0c0e'; x.lineWidth = 0.07 * k;
        x.beginPath(); x.moveTo(cx - 0.28 * k, feet - 1.0 * k); x.lineTo(cx + 0.3 * k, feet - 1.35 * k); x.stroke();
        x.restore();
      }
    };
    sheet(w * 0.25, C.ink, false);
    sheet(w * 0.55, '#4a7396', true);
    font(x, 12.5); x.textAlign = 'center';
    x.fillStyle = C.bad; x.fillText('적: 검은 실루엣+소총', w * 0.25, h * 0.92);
    x.fillStyle = C.blue; x.fillText('민간인: 손 든 파란 실루엣', w * 0.58, h * 0.92);
    x.fillStyle = C.warn; x.textAlign = 'left'; font(x, 12);
    x.fillText('민간인·인질 피격', w * 0.76, h * 0.36);
    x.fillStyle = C.bad; font(x, 13, 700);
    x.fillText('= 즉시 실패', w * 0.76, h * 0.5);
  }

  /* 방아쇠 슬라이더 */
  function trigger(x, w, h) {
    base(x, w, h);
    const tx = w * 0.3, ty = h * 0.14, tw = w * 0.14, th = h * 0.72;
    x.fillStyle = C.panel; x.fillRect(tx, ty, tw, th);
    x.strokeStyle = C.line; x.strokeRect(tx, ty, tw, th);
    x.strokeStyle = C.bad; x.lineWidth = 2;
    x.beginPath(); x.moveTo(tx - 6, ty + th * 0.72); x.lineTo(tx + tw + 6, ty + th * 0.72); x.stroke();
    x.lineWidth = 1;
    x.fillStyle = C.txt; x.fillRect(tx + 3, ty + th * 0.3, tw - 6, th * 0.16);
    x.strokeStyle = C.accent;
    x.beginPath(); x.moveTo(tx + tw / 2, ty + th * 0.5); x.lineTo(tx + tw / 2, ty + th * 0.66); x.stroke();
    x.fillStyle = C.accent;
    x.beginPath(); x.moveTo(tx + tw / 2, ty + th * 0.7); x.lineTo(tx + tw / 2 - 6, ty + th * 0.58); x.lineTo(tx + tw / 2 + 6, ty + th * 0.58); x.fill();
    font(x, 12.5); x.textAlign = 'left';
    x.fillStyle = C.txt; x.fillText('방아쇠를 아래로 당긴다', w * 0.52, h * 0.3);
    x.fillStyle = C.bad; x.fillText('빨간 선을 넘는 순간 격발', w * 0.52, h * 0.5);
    x.fillStyle = C.dim; x.fillText('숨을 참고 천천히 —', w * 0.52, h * 0.68);
  }

  /* 국지풍 */
  function localwind(x, w, h) {
    base(x, w, h);
    font(x, 12.5); x.textAlign = 'center';
    // 사수
    x.fillStyle = C.txt; x.fillText('사수', w * 0.14, h * 0.82);
    x.fillStyle = C.blue; x.fillText('풍속계 2 m/s →', w * 0.14, h * 0.3);
    x.strokeStyle = C.blue;
    x.beginPath(); x.moveTo(w * 0.06, h * 0.42); x.lineTo(w * 0.2, h * 0.42); x.stroke();
    // 표적
    x.fillStyle = C.txt; x.fillText('표적', w * 0.84, h * 0.82);
    x.fillStyle = C.warn; x.fillText('← 실제 5 m/s', w * 0.82, h * 0.3);
    x.strokeStyle = C.warn; x.lineWidth = 2.5;
    x.beginPath(); x.moveTo(w * 0.94, h * 0.42); x.lineTo(w * 0.72, h * 0.42); x.stroke();
    x.lineWidth = 1;
    // 깃발
    x.strokeStyle = C.dim;
    x.beginPath(); x.moveTo(w * 0.6, h * 0.75); x.lineTo(w * 0.6, h * 0.48); x.stroke();
    x.fillStyle = C.bad;
    x.beginPath(); x.moveTo(w * 0.6, h * 0.5); x.lineTo(w * 0.48, h * 0.56); x.lineTo(w * 0.6, h * 0.62); x.fill();
    x.fillStyle = C.dim; x.fillText('깃발을 믿어라', w * 0.56, h * 0.9);
  }

  return { layout, drop, windclock, air, ranging, zones, cep, coriolis, roe, trigger, localwind };
})();

/* ── 레슨 데이터 (전부 무료) ── */
const Lessons = [
  {
    id: 'tutorial', title: '튜토리얼 — 기본 조작', thumb: 'layout',
    sections: [
      { d: 'layout', h: '화면 구성', b: '상단은 스코프, 하단은 컨트롤 패널이다. 스코프 영역을 드래그하면 조준이 움직이고, 스코프 둘레의 노브(상단 고각·우측 윈디지)와 좌측 배율 바로 조준경을 조작한다. 하단 패널은 조작 / 탄도 / 측거표 세 탭으로 나뉜다.' },
      { d: null, h: '조준과 배율', b: '스코프를 드래그해 표적을 레티클 중앙에 올린다. 좌측 배율 바의 +/−를 누르거나 트랙을 드래그하면 5~25배로 확대·축소된다. 배율을 올리면 정밀해지지만 흔들림도 크게 보인다.' },
      { d: null, h: '터렛 조정', b: '상단 고각 노브는 오른쪽으로 드래그(또는 중앙 기준 오른쪽 탭)하면 증가, 왼쪽이면 감소한다. 우측 윈디지 노브는 위로 드래그하면 증가한다. 1클릭 = 0.1 mil이며, 조정값은 탄도 탭과 우하단에 표시된다.' },
      { d: 'trigger', h: '숨참기와 격발', b: '숨참기는 토글이다 — 버튼(또는 Shift)을 한 번 눌러 켜고, 다시 눌러 끈다. 꾹 누르고 있을 필요가 없다. 켜져 있는 동안 조준 흔들림이 크게 줄고 조준 이동 감도도 낮아져 미세 조정이 쉬워진다. 산소가 다 떨어지면 자동으로 숨을 내쉬고 한동안 조준이 더 흔들린다. 격발은 방아쇠 슬라이더를 아래로 당겨 빨간 선을 넘기는 순간 이뤄진다 — 숨을 참고, 천천히.' },
      { d: 'zones', h: '명중 판정', b: '표적지 부위마다 점수가 다르다: 머리 10점(+헤드샷 2점), 흉부 9점, 복부 7점, 하지 5점, 팔 4점. 첫 발 명중에는 보너스 5점이 붙는다. 스코프 좌상단 점들이 남은 탄과 명중/빗나감 기록을 보여준다.' },
      { d: null, h: '자동 재장전과 제한 시간', b: '탄창이 비면 자동으로 재장전된다(2.5초). 임무는 제한 시간 안에 모든 적을 제압해야 하며, 정확도·잔여 시간·헤드샷 비율로 S/A/B/C 등급이 매겨진다.' },
    ],
  },
  {
    id: 'drop', title: '탄도 낙차', thumb: 'drop',
    sections: [
      { d: 'drop', h: '중력과 낙차', b: '탄은 총구를 떠나는 순간부터 떨어진다. 조준선은 직선이지만 탄도는 포물선이어서, 거리가 멀수록 조준점 아래로 낙차가 커진다. 이 게임의 모든 총기는 100 m 영점 기준이다.' },
      { d: null, h: 'DOPE 표 읽기', b: '탄도 탭(데스크톱은 우측 패널)의 DOPE 표는 거리별 필요 고각(mil)과 풍속별 편류(mil)를 보여준다. 예: 600 m 행의 고각 4.0이면 엘리베이션을 40클릭 올린다. 거리 하이라이트를 끄면 거리 가늠부터 스스로 해야 한다.' },
      { d: null, h: '거리가 다른 표적', b: '표적마다 거리가 다르다. 레티클을 표적에 올리면 레이저 측거 거리(◆)가 표시되고 DOPE 강조 행이 그 거리로 바뀐다. 표적을 바꿀 때마다 고각을 다시 맞춰라.' },
    ],
  },
  {
    id: 'wind', title: '바람 판독', thumb: 'windclock',
    sections: [
      { d: 'windclock', h: '풍향 시계', b: '바람은 3시·9시 방향(측풍)일 때 편류가 최대(full value)이고, 12시·6시(정풍·배풍)는 편류가 거의 없다. 비스듬한 바람은 cos 성분만 적용된다 — DOPE 표의 풍속열은 full value 기준이다.' },
      { d: 'localwind', h: '풍속계 vs 깃발', b: '풍속계는 사수 위치의 바람만 잰다. "국지풍" 상황에서는 표적 지역 바람이 풍속계와 다를 수 있다 — 이때는 사거리를 따라 서 있는 깃발의 기울기와 펄럭임을 믿어야 한다.' },
      { d: null, h: '돌풍 관리', b: '풍속계의 45초 그래프로 바람의 리듬을 읽어라. 돌풍 전선에서는 변동이 극심하고, 정온 창에서는 바람이 잦아든다. 잠잠해지는 순간을 기다렸다가 쏘는 것도 기술이다.' },
    ],
  },
  {
    id: 'air', title: '공기 밀도', thumb: 'air',
    sections: [
      { d: 'air', h: '밀도를 바꾸는 세 요인', b: '기온이 높거나 고도가 높으면 공기가 희박해져 항력이 줄고 낙차가 감소한다. 습도는 영향이 작지만 같은 방향이다. 좌상단 패널의 기온·습도·고도·기압이 이번 판의 대기 조건이다.' },
      { d: null, h: '맵별 기후', b: '사막(30~48℃)과 고산(고도 2,000 m)은 같은 거리라도 필요 고각이 다르다. DOPE 표는 이번 판의 대기 조건으로 계산되므로 표를 신뢰하면 된다 — 단, 매판 기상이 랜덤이라 표도 판마다 달라진다.' },
    ],
  },
  {
    id: 'ranging', title: '밀 측거', thumb: 'ranging',
    sections: [
      { d: 'ranging', h: 'mil로 거리 재기', b: '1 mil은 1,000 m에서 1 m에 해당하는 각도다. 레티클 눈금으로 표적 크기를 재면 거리를 역산할 수 있다: 거리(m) = 실제 크기(m) ÷ 측정 mil × 1000. 사람 키 1.8 m가 2.6 mil로 보이면 약 692 m다.' },
      { d: null, h: '측거표 사용', b: '하단 패널의 측거표 탭은 거리별로 전신(55×180 cm)·흉부·머리가 몇 mil로 보이는지 정리한 표다. 레티클 측정값과 표를 대조하면 빠르게 거리를 특정할 수 있다. 거리 하이라이트를 끄고 측거 훈련을 해보자.' },
    ],
  },
  {
    id: 'spin', title: '코리올리와 스핀 편류', thumb: 'coriolis',
    sections: [
      { d: 'coriolis', h: '지구 자전의 영향', b: '1 km를 넘는 사격에서는 지구 자전이 탄도를 휘게 한다. 북반구에서는 오른쪽으로, 동·서 방향 사격에서는 위아래로도 편차가 생긴다(에트뵈시 효과). 설원 초장거리 맵에서는 지구 곡률까지 계산에 들어간다.' },
      { d: null, h: '스핀 편류', b: '총열의 강선 때문에 탄은 회전하며 날아가고, 이 회전이 비행시간에 비례해 오른쪽으로 미세한 편류를 만든다. 800 m에서 약 10~20 cm — 정밀 사격에서는 무시할 수 없다.' },
    ],
  },
  {
    id: 'accuracy', title: '명중률 분석', thumb: 'cep',
    sections: [
      { d: 'cep', h: '탄착군과 공산오차', b: '같은 조준으로 쏴도 총구속도 편차·조준 흔들림·바람 오차 때문에 탄착점은 퍼진다. 탄착의 50%가 들어오는 원이 CEP, 수직·수평 공산오차가 REP·DEP다.' },
      { d: null, h: '두 가지 예측 방법', b: '데스크톱에서 A 키를 누르면 현재 조건의 명중률을 두 방법으로 계산해 비교한다: 몬테카를로 400발 탄착군(실험적 방법)과 편미분 민감도 합성(해석적 방법). 두 값이 가까울수록 예측이 안정적이라는 뜻이다. (KSME 2017 논문 방식)' },
    ],
  },
  {
    id: 'roe', title: '교전 수칙', thumb: 'roe',
    sections: [
      { d: 'roe', h: '표적 식별', b: '적은 소총을 든 검은 실루엣 표적지, 민간인은 두 손을 든 파란 실루엣이다. 민간인이나 인질을 맞히면 그 즉시 임무 실패다. 쏘기 전에 반드시 식별하라.' },
      { d: null, h: '인질 상황', b: '인질전에서는 인질이 적에 바짝 붙어 있고, 탄도상 인질이 먼저 판정된다. 바람과 낙차를 완전히 보정하고 노출된 부위만 정확히 노려야 한다. 서두르면 인질을 맞힌다.' },
      { d: null, h: '상황은 매판 다르다', b: '인질전·국지풍·정온·돌풍 전선 등 상황이 매 판 랜덤으로 주어지고, 좌상단 임무 패널(모바일은 상단 바)에 표시된다. 모든 시나리오와 레슨은 잠금 없이 전부 무료다.' },
    ],
  },
];
