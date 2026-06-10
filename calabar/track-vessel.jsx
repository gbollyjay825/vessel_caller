/* global React, Icon, PORT, VOYAGES, bezierAt, haversineNm, bearing, fmtLatLon, fmtDateTime, fmtNum */
const { useState: useStateTrk, useEffect: useEffectTrk, useMemo: useMemoTrk } = React;

// chart bounds (Gulf of Guinea)
const CB = { lonMin: -6, lonMax: 13.5, latMin: -2.2, latMax: 8 };
const MAPW = 720, MAPH = 460;
const projX = (lon) => ((lon - CB.lonMin) / (CB.lonMax - CB.lonMin)) * MAPW;
const projY = (lat) => MAPH - ((lat - CB.latMin) / (CB.latMax - CB.latMin)) * MAPH;

// sample the bezier into screen points
function routePoints(o, d, n = 60) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = bezierAt(o, d, i / n);
    pts.push([projX(p.lon), projY(p.lat)]);
  }
  return pts;
}
function pathFrom(pts) { return 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L'); }

function TrackVessel({ call }) {
  const voyage = VOYAGES[call.id];
  const dest = PORT.calabar;
  const origin = voyage ? PORT[voyage.origin] : null;

  // live jitter — nudges progress + refreshes "last report"
  const [tick, setTick] = useStateTrk(0);
  useEffectTrk(() => {
    if (!voyage || voyage.progress >= 1) return;
    const id = setInterval(() => setTick((t) => t + 1), 3200);
    return () => clearInterval(id);
  }, [voyage]);

  const live = useMemoTrk(() => {
    if (!voyage) return null;
    const moored = voyage.progress >= 1;
    const prog = moored ? 1 : Math.min(0.985, voyage.progress + tick * 0.004);
    const cur = bezierAt(origin, dest, prog);
    const ahead = bezierAt(origin, dest, Math.min(1, prog + 0.02));
    const hdg = moored ? voyage.course : bearing(cur, ahead);
    const toGo = haversineNm(cur, dest);
    const totalNm = haversineNm(origin, dest);
    const spd = moored ? 0 : +(voyage.speed + Math.sin(tick) * 0.4).toFixed(1);
    const etaHrs = spd > 0.5 ? toGo / spd : 0;
    return { moored, prog, cur, hdg, toGo, totalNm, spd, etaHrs };
  }, [voyage, tick, origin, dest]);

  if (!voyage) {
    return (
      <div className="card card-pad section-gap">
        <div className="card-title" style={{ marginBottom: 6 }}>Live position</div>
        <p className="muted" style={{ fontSize: 13 }}>No AIS track is available for this vessel yet. Tracking begins once the vessel reports a position en route to Calabar.</p>
      </div>
    );
  }

  const fll = fmtLatLon(live.cur.lon, live.cur.lat);
  const rt = routePoints(origin, dest);
  const splitIdx = Math.round(live.prog * (rt.length - 1));
  const sailed = rt.slice(0, splitIdx + 1);
  const remaining = rt.slice(splitIdx);
  const vx = projX(live.cur.lon), vy = projY(live.cur.lat);
  const ox = projX(origin.lon), oy = projY(origin.lat);
  const dx = projX(dest.lon), dy = projY(dest.lat);

  const graticule = [];
  for (let lon = -5; lon <= 13; lon += 3) graticule.push(['v', projX(lon), lon + '°E']);
  for (let lat = -2; lat <= 8; lat += 2) graticule.push(['h', projY(lat), lat + '°N']);

  const etaText = live.moored ? 'Berthed' : live.etaHrs >= 24
    ? `${Math.floor(live.etaHrs / 24)}d ${Math.round(live.etaHrs % 24)}h`
    : `${Math.round(live.etaHrs)}h`;

  return (
    <div className="card section-gap track-card">
      <div className="card-head">
        <div className="flex items-center gap-3">
          <div className="card-title">Live vessel tracking</div>
          <span className={'live-pill ' + (live.moored ? 'moored' : '')}>
            <span className="lp-dot" />{live.moored ? 'In port' : 'Live · AIS'}
          </span>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>Last report {live.moored ? fmtDateTime(voyage.lastReport) : 'just now'}</span>
      </div>

      <div className="track-grid">
        {/* ---- chart ---- */}
        <div className="track-map">
          <svg viewBox={`0 0 ${MAPW} ${MAPH}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={`Chart showing ${call.vesselName} en route to Calabar`}>
            <defs>
              <radialGradient id="seaGrad" cx="62%" cy="78%" r="80%">
                <stop offset="0%" stopColor="#EAF2FB" />
                <stop offset="100%" stopColor="#DCE9F6" />
              </radialGradient>
              <filter id="vShadow" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="1" stdDeviation="1.6" floodColor="#0E2236" floodOpacity="0.35" />
              </filter>
            </defs>
            <rect x="0" y="0" width={MAPW} height={MAPH} fill="url(#seaGrad)" />

            {/* graticule */}
            {graticule.map(([dir, pos, label], i) => dir === 'v'
              ? <g key={i}><line x1={pos} y1="0" x2={pos} y2={MAPH} stroke="#C5D8EC" strokeWidth="1" strokeDasharray="2 5" /><text x={pos + 3} y={MAPH - 8} fontSize="10" fill="#7C93AC">{label}</text></g>
              : <g key={i}><line x1="0" y1={pos} x2={MAPW} y2={pos} stroke="#C5D8EC" strokeWidth="1" strokeDasharray="2 5" /><text x="6" y={pos - 4} fontSize="10" fill="#7C93AC">{label}</text></g>
            )}

            {/* stylised coastline band (decorative) */}
            <path d={`M0,${projY(7.4)} C ${MAPW*0.2},${projY(6.6)} ${MAPW*0.3},${projY(7.0)} ${MAPW*0.42},${projY(6.3)} S ${MAPW*0.6},${projY(4.2)} ${MAPW*0.72},${projY(4.6)} S ${MAPW*0.9},${projY(3.0)} ${MAPW},${projY(2.4)} L${MAPW},0 L0,0 Z`}
              fill="#EFEAD9" opacity="0.6" />
            <path d={`M0,${projY(7.4)} C ${MAPW*0.2},${projY(6.6)} ${MAPW*0.3},${projY(7.0)} ${MAPW*0.42},${projY(6.3)} S ${MAPW*0.6},${projY(4.2)} ${MAPW*0.72},${projY(4.6)} S ${MAPW*0.9},${projY(3.0)} ${MAPW},${projY(2.4)}`}
              fill="none" stroke="#D8CDA8" strokeWidth="1.5" />

            {/* route */}
            <path className="trk-remaining" d={pathFrom(remaining)} fill="none" stroke="#1B5FAA" strokeWidth="2" strokeDasharray="6 6" strokeLinecap="round" opacity="0.55" />
            <path d={pathFrom(sailed)} fill="none" stroke="#1B5FAA" strokeWidth="2.5" strokeLinecap="round" />

            {/* origin */}
            <g>
              <circle cx={ox} cy={oy} r="6" fill="#fff" stroke="#5F6B7A" strokeWidth="2" />
              <text x={ox} y={oy + 20} fontSize="11.5" fontWeight="600" fill="#41506180" textAnchor="middle" style={{ fill: '#415061' }}>{origin.name.split(',')[0]}</text>
            </g>
            {/* destination — Calabar */}
            <g>
              <circle cx={dx} cy={dy} r="11" fill="#1B5FAA" opacity="0.14" />
              <circle cx={dx} cy={dy} r="5.5" fill="#1B5FAA" stroke="#fff" strokeWidth="2" />
              <text x={dx} y={dy - 14} fontSize="12" fontWeight="700" fill="#16191D" textAnchor="middle">Calabar ⚓</text>
            </g>

            {/* vessel marker */}
            <g transform={`translate(${vx},${vy})`}>
              {!live.moored && <circle className="trk-pulse" r="9" fill="#F58220" />}
              <g transform={`rotate(${live.hdg})`} filter="url(#vShadow)">
                <path d="M0,-11 L7,9 L0,4 L-7,9 Z" fill={live.moored ? '#5F6B7A' : '#F58220'} stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              </g>
            </g>
          </svg>

          <div className="track-map-foot">
            <span className="tmf-i"><span className="dotline solid" /> Sailed</span>
            <span className="tmf-i"><span className="dotline dash" /> Remaining</span>
            <span className="tmf-i"><span className="tri" /> {call.vesselName}</span>
          </div>
        </div>

        {/* ---- telemetry ---- */}
        <div className="track-side">
          <div className="track-pos">
            <div className="tp-label"><Icon name="mapPin" size={13} strokeWidth={2} /> Current position</div>
            <div className="tp-coords tnum">{fll.lat} &nbsp; {fll.lon}</div>
            <div className="tp-sub">{live.moored ? 'Alongside ' + (call.berth || 'berth') : `${fmtNum(live.toGo)} nm to Calabar`}</div>
          </div>

          <div className="telem-grid">
            <div className="telem"><div className="tl-k"><Icon name="gauge" size={13} strokeWidth={2} /> Speed</div><div className="tl-v tnum">{live.spd.toFixed(1)}<span className="u">kn</span></div></div>
            <div className="telem"><div className="tl-k"><Icon name="compass" size={13} strokeWidth={2} /> Course</div><div className="tl-v tnum">{String(live.hdg).padStart(3, '0')}<span className="u">°</span></div></div>
            <div className="telem"><div className="tl-k"><Icon name="ruler" size={13} strokeWidth={2} /> Draught</div><div className="tl-v tnum">{voyage.draught}<span className="u">m</span></div></div>
            <div className="telem"><div className="tl-k"><Icon name="calendar" size={13} strokeWidth={2} /> ETA</div><div className="tl-v tnum">{etaText}</div></div>
          </div>

          <div className="voyage-line">
            <div className="vl-pt"><span className="vl-dot o" /><div><div className="vl-name">{origin.name}</div><div className="vl-code">Departed · {origin.code}</div></div></div>
            <div className="vl-track"><div className="vl-fill" style={{ width: (live.prog * 100) + '%' }} /></div>
            <div className="vl-pt"><span className="vl-dot d" /><div><div className="vl-name">{dest.name}</div><div className="vl-code">Destination · {dest.code}</div></div></div>
          </div>

          <div className="ais-meta">
            <div className="ais-h"><Icon name="radio" size={13} strokeWidth={2} /> AIS · static &amp; voyage data</div>
            <div className="ais-row"><span className="k">Nav status</span><span className="v">{voyage.navStatus}</span></div>
            <div className="ais-row"><span className="k">MMSI</span><span className="v tnum">{voyage.mmsi}</span></div>
            <div className="ais-row"><span className="k">IMO</span><span className="v tnum">{voyage.imo}</span></div>
            <div className="ais-row"><span className="k">Call sign</span><span className="v">{voyage.callSign}</span></div>
            <div className="ais-row"><span className="k">Flag</span><span className="v">{call.flag}</span></div>
            <div className="ais-row"><span className="k">Route distance</span><span className="v tnum">{fmtNum(live.totalNm)} nm</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.TrackVessel = TrackVessel;
