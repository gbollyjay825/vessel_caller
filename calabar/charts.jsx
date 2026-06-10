/* global React */
const { useState: useStateCh, useRef: useRefCh } = React;

function fmtCompactMT(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}
function fmtCompactUSD(n) {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}

// =========================================================
// Stacked area — throughput over time (liquid + dry)
// Full geometry; entrance animated via CSS (line-draw + fade).
// =========================================================
function AreaTrend({ series }) {
  const [hover, setHover] = useStateCh(null);
  const wrapRef = useRefCh(null);
  const W = 760, H = 300, padL = 12, padR = 12, padT = 18, padB = 30;
  const n = series.length;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...series.map((d) => d.liquidT + d.dryT)) * 1.12;
  const x = (i) => padL + (innerW * i) / (n - 1);
  const y = (v) => padT + innerH - (innerH * v) / max;

  const dryTop = series.map((d, i) => [x(i), y(d.dryT)]);
  const liqTop = series.map((d, i) => [x(i), y(d.dryT + d.liquidT)]);
  const base = padT + innerH;

  const areaPath = (top, bottom) => {
    const head = 'M' + top.map((p) => p.join(',')).join(' L');
    if (Array.isArray(bottom)) return head + ' L' + [...bottom].reverse().map((p) => p.join(',')).join(' L') + ' Z';
    return head + ` L${top[top.length - 1][0]},${bottom} L${top[0][0]},${bottom} Z`;
  };
  const linePath = (top) => 'M' + top.map((p) => p.join(',')).join(' L');

  const onMove = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };
  const gl = [0.25, 0.5, 0.75, 1];

  return (
    <div className="chart-wrap" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {gl.map((g, i) => (<line key={i} x1={padL} x2={W - padR} y1={padT + innerH * (1 - g)} y2={padT + innerH * (1 - g)} stroke="#EEF1F4" strokeWidth="1" />))}
        <path className="ct-area" d={areaPath(dryTop, base)} fill="#D9A441" fillOpacity="0.15" />
        <path className="ct-area" d={areaPath(liqTop, dryTop)} fill="#1B5FAA" fillOpacity="0.15" style={{ animationDelay: '90ms' }} />
        <path className="ct-area" d={linePath(dryTop)} fill="none" stroke="#D9A441" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" style={{ animationDelay: '160ms' }} />
        <path className="ct-area" d={linePath(liqTop)} fill="none" stroke="#1B5FAA" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" style={{ animationDelay: '220ms' }} />
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={base} stroke="#C3C9D6" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(series[hover].dryT + series[hover].liquidT)} r="5" fill="#1B5FAA" stroke="#fff" strokeWidth="2" />
            <circle cx={x(hover)} cy={y(series[hover].dryT)} r="4.5" fill="#D9A441" stroke="#fff" strokeWidth="2" />
          </g>
        )}
        {series.map((d, i) => (<text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="12" fill="#8A95A3" fontWeight="500">{d.month}</text>))}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <div className="tip-h">{series[hover].month} {series[hover].year}</div>
          <div className="tip-row"><span className="sw" style={{ background: '#1B5FAA' }} />Liquid<b>{fmtCompactMT(series[hover].liquidT)} MT</b></div>
          <div className="tip-row"><span className="sw" style={{ background: '#D9A441' }} />Dry<b>{fmtCompactMT(series[hover].dryT)} MT</b></div>
        </div>
      )}
    </div>
  );
}

// =========================================================
// Stacked bars — revenue over time (liquid + dry)
// =========================================================
function RevenueBars({ series }) {
  const [hover, setHover] = useStateCh(null);
  const W = 760, H = 280, padL = 12, padR = 12, padT = 16, padB = 30;
  const n = series.length, innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...series.map((d) => d.liquidR + d.dryR)) * 1.1;
  const bw = Math.min(34, (innerW / n) * 0.56);
  const cx = (i) => padL + (innerW * (i + 0.5)) / n;
  const baseY = padT + innerH;
  const h = (v) => (innerH * v) / max;
  const gl = [0.25, 0.5, 0.75, 1];

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {gl.map((g, i) => (<line key={i} x1={padL} x2={W - padR} y1={padT + innerH * (1 - g)} y2={padT + innerH * (1 - g)} stroke="#EEF1F4" strokeWidth="1" />))}
        {series.map((d, i) => {
          const hLiq = h(d.liquidR), hDry = h(d.dryR);
          const xx = cx(i) - bw / 2;
          const on = hover === i;
          const delay = `${i * 45}ms`;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} style={{ cursor: 'pointer' }}>
              <rect x={xx - 3} y={padT} width={bw + 6} height={innerH} fill={on ? '#F2F7FC' : 'transparent'} rx="5" />
              <rect className="ct-rise" x={xx} y={baseY - hDry} width={bw} height={hDry} fill="#D9A441" rx="3" opacity={on || hover == null ? 1 : 0.5} style={{ animationDelay: delay }} />
              <rect className="ct-rise" x={xx} y={baseY - hDry - hLiq} width={bw} height={hLiq} fill="#1B5FAA" rx="3" opacity={on || hover == null ? 1 : 0.5} style={{ animationDelay: delay }} />
              <text x={cx(i)} y={H - 8} textAnchor="middle" fontSize="12" fill="#8A95A3" fontWeight="500">{d.month}</text>
              {on && <text x={cx(i)} y={baseY - hDry - hLiq - 8} textAnchor="middle" fontSize="12.5" fontWeight="700" fill="#16191D">{fmtCompactUSD(d.liquidR + d.dryR)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// =========================================================
// Donut — product mix by volume
// =========================================================
function MixDonut({ products, total }) {
  const [hover, setHover] = useStateCh(null);
  const S = 240, r = 86, cxy = S / 2, C = 2 * Math.PI * r, sw = 30;
  let acc = 0;
  const segs = products.map((p) => {
    const frac = p.tonnage / total;
    const seg = { ...p, frac, offset: acc };
    acc += frac;
    return seg;
  });
  const focus = hover != null ? segs[hover] : null;

  return (
    <div className="donut-wrap">
      <svg viewBox={`0 0 ${S} ${S}`} style={{ width: 200, height: 200 }}>
        <circle cx={cxy} cy={cxy} r={r} fill="none" stroke="#F2F4F8" strokeWidth={sw} />
        <g transform={`rotate(-90 ${cxy} ${cxy})`}>
          {segs.map((s, i) => (
            <circle key={i} className="ct-rise" cx={cxy} cy={cxy} r={r} fill="none" stroke={s.color}
              strokeWidth={hover === i ? sw + 6 : sw}
              strokeDasharray={`${C * s.frac} ${C}`}
              strokeDashoffset={-C * s.offset}
              style={{ transition: 'stroke-width 140ms ease', animationDelay: `${i * 80}ms`, cursor: 'pointer', opacity: hover == null || hover === i ? 1 : 0.4 }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          ))}
        </g>
        <text x={cxy} y={cxy - 6} textAnchor="middle" fontSize="15" fontWeight="600" fill="#8A95A3">{focus ? focus.key : 'Total'}</text>
        <text x={cxy} y={cxy + 20} textAnchor="middle" fontSize="26" fontWeight="700" fill="#16191D">{focus ? (focus.frac * 100).toFixed(0) + '%' : fmtCompactMT(total) + ' MT'}</text>
      </svg>
      <div className="donut-legend">
        {segs.map((s, i) => (
          <div key={i} className={'leg-row ' + (hover === i ? 'on' : '')} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="sw" style={{ background: s.color }} />
            <span className="leg-l">{s.label}</span>
            <span className="leg-v tnum">{fmtCompactMT(s.tonnage)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// mini sparkline (line-draw entrance)
function MiniSpark({ values, color = '#1B5FAA', w = 120, h = 36 }) {
  const max = Math.max(...values), min = Math.min(...values);
  const n = values.length;
  const x = (i) => (w * i) / (n - 1);
  const y = (v) => h - 3 - ((h - 6) * (v - min)) / (max - min || 1);
  const pts = values.map((v, i) => [x(i), y(v)]);
  const d = 'M' + pts.map((p) => p.join(',')).join(' L');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: w, height: h }} preserveAspectRatio="none">
      <path className="ct-area" d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity="0.10" />
      <path className="ct-area" d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

Object.assign(window, { fmtCompactMT, fmtCompactUSD, AreaTrend, RevenueBars, MixDonut, MiniSpark });
