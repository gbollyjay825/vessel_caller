/* global React, Icon, AN_SERIES, PRODUCTS, AreaTrend, RevenueBars, MixDonut, MiniSpark, fmtCompactMT, fmtCompactUSD, fmtNum, fmtUSD */
const { useState: useStateAn, useMemo: useMemoAn } = React;

function Analytics({ store }) {
  const [period, setPeriod] = useStateAn(12);
  const [shown, setShown] = useStateAn(false);
  React.useEffect(() => { const id = setTimeout(() => setShown(true), 40); return () => clearTimeout(id); }, []);
  const series = useMemoAn(() => AN_SERIES.slice(-period), [period]);

  const totals = useMemoAn(() => {
    const liquidT = series.reduce((s, d) => s + d.liquidT, 0);
    const dryT = series.reduce((s, d) => s + d.dryT, 0);
    const liquidR = series.reduce((s, d) => s + d.liquidR, 0);
    const dryR = series.reduce((s, d) => s + d.dryR, 0);
    const calls = series.reduce((s, d) => s + d.calls, 0);
    return { liquidT, dryT, liquidR, dryR, calls, throughput: liquidT + dryT, revenue: liquidR + dryR };
  }, [series]);

  // product mix scaled to the selected period
  const products = useMemoAn(() => PRODUCTS.map((p) => {
    const catT = p.cat === 'Liquid' ? totals.liquidT : totals.dryT;
    const catR = p.cat === 'Liquid' ? totals.liquidR : totals.dryR;
    return { ...p, tonnage: Math.round(catT * p.share), revenue: Math.round(catR * p.share) };
  }), [totals]);

  const pms = products.find((p) => p.key === 'PMS');
  const leaderboard = [...products].sort((a, b) => b.tonnage - a.tonnage);
  const maxT = leaderboard[0].tonnage;
  const callsSeries = series.map((d) => d.calls);
  const liqPct = (totals.liquidT / totals.throughput) * 100;
  const periodLabel = period === 12 ? 'Last 12 months' : `Last ${period} months`;
  const portName = store.portLabel || store.settings.portName;

  return (
    <div className={'content-inner' + (shown ? ' charts-in' : '')}>
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Analytics</h1>
          <p className="desc">Cargo throughput and revenue across {portName} — petroleum (PMS, AGO, DPK) against dry &amp; bulk cargo.</p>
        </div>
        <div className="seg" role="tablist" aria-label="Period">
          {[[3, '3M'], [6, '6M'], [12, '12M']].map(([k, l]) => (
            <button key={k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* KPI strip */}
      <div className="kpi-strip">
        <div className="stat-card an-kpi">
          <div className="stat-label">Cargo throughput</div>
          <div className="stat-num tnum">{fmtCompactMT(totals.throughput)}<span className="cur" style={{ marginLeft: 6, marginRight: 0 }}>MT</span></div>
          <div className="split-bar"><div className="seg-l" style={{ width: liqPct + '%' }} /><div className="seg-d" style={{ width: (100 - liqPct) + '%' }} /></div>
          <div className="split-leg">
            <span className="sl-i"><span className="sw" style={{ background: 'var(--accent)' }} /> Liquid {fmtCompactMT(totals.liquidT)}</span>
            <span className="sl-i"><span className="sw" style={{ background: '#D9A441' }} /> Dry {fmtCompactMT(totals.dryT)}</span>
          </div>
        </div>

        <div className="stat-card an-kpi">
          <div className="stat-label">Total revenue</div>
          <div className="stat-num tnum">{fmtCompactUSD(totals.revenue)}</div>
          <div className="split-bar"><div className="seg-l" style={{ width: (totals.liquidR / totals.revenue * 100) + '%' }} /><div className="seg-d" style={{ width: (totals.dryR / totals.revenue * 100) + '%' }} /></div>
          <div className="split-leg">
            <span className="sl-i"><span className="sw" style={{ background: 'var(--accent)' }} /> Liquid {fmtCompactUSD(totals.liquidR)}</span>
            <span className="sl-i"><span className="sw" style={{ background: '#D9A441' }} /> Dry {fmtCompactUSD(totals.dryR)}</span>
          </div>
        </div>

        <div className="stat-card an-kpi">
          <div className="stat-label">Vessel calls</div>
          <div className="stat-num tnum">{fmtNum(totals.calls)}</div>
          <div style={{ marginTop: 6 }}><MiniSpark values={callsSeries} color="#1B5FAA" w={150} h={34} /></div>
          <div className="stat-sub">{periodLabel}</div>
        </div>

        <div className="stat-card an-kpi">
          <div className="stat-label">Liquid share</div>
          <div className="stat-num tnum">{liqPct.toFixed(0)}<span className="cur" style={{ marginLeft: 2, marginRight: 0 }}>%</span></div>
          <div className="stat-sub" style={{ marginTop: 8 }}><span className="delta up"><Icon name="arrowRight" size={13} strokeWidth={2.2} style={{ transform: 'rotate(-45deg)' }} />4.2 pts</span> of total tonnage</div>
        </div>
      </div>

      {/* throughput + donut */}
      <div className="an-grid section-gap">
        <div className="card card-pad">
          <div className="card-head" style={{ padding: 0, border: 'none', marginBottom: 4 }}>
            <div className="card-title">Cargo throughput over time</div>
            <div className="chart-legend">
              <span className="cl"><span className="sw" style={{ background: '#1B5FAA' }} /> Liquid</span>
              <span className="cl"><span className="sw" style={{ background: '#D9A441' }} /> Dry / bulk</span>
            </div>
          </div>
          <AreaTrend series={series} />
        </div>
        <div className="card card-pad">
          <div className="card-title">Product mix by volume</div>
          <MixDonut products={products} total={totals.throughput} />
        </div>
      </div>

      {/* revenue + PMS spotlight */}
      <div className="an-grid section-gap">
        <div className="card card-pad">
          <div className="card-head" style={{ padding: 0, border: 'none', marginBottom: 4 }}>
            <div className="card-title">Revenue · liquid vs dry</div>
            <div className="chart-legend">
              <span className="cl"><span className="sw" style={{ background: '#1B5FAA' }} /> Liquid</span>
              <span className="cl"><span className="sw" style={{ background: '#D9A441' }} /> Dry / bulk</span>
            </div>
          </div>
          <RevenueBars series={series} />
        </div>
        <div className="spotlight">
          <div className="sl-eyebrow"><Icon name="droplet" size={14} strokeWidth={2} /> PMS · Premium Motor Spirit</div>
          <div className="sl-num tnum">{fmtCompactMT(pms.tonnage)}<span className="sl-unit">MT discharged</span></div>
          <div className="sl-sub">{(pms.tonnage / totals.throughput * 100).toFixed(0)}% of all cargo across {portName} · {periodLabel.toLowerCase()}</div>
          <div className="sl-divide" />
          <div className="sl-row"><span className="l">Revenue from PMS</span><span className="v tnum">{fmtCompactUSD(pms.revenue)}</span></div>
          <div className="sl-spark"><MiniSpark values={series.map((d) => Math.round(d.liquidT * pms.share))} color="#FFFFFF" w={260} h={40} /></div>
        </div>
      </div>

      {/* leaderboard */}
      <div className="card section-gap">
        <div className="card-head">
          <div className="card-title">Cargo by product</div>
          <span className="muted" style={{ fontSize: 13 }}>{periodLabel} · ranked by volume</span>
        </div>
        <div className="table-wrap">
          <table className="lead-table">
            <tbody>
              {leaderboard.map((p, i) => (
                <tr key={p.key}>
                  <td className="lead-rank">{i + 1}</td>
                  <td><div className="lead-name"><span className="sw" style={{ background: p.color, width: 12, height: 12 }} /> {p.label} <span className={'tag ' + (p.cat === 'Liquid' ? 'liquid' : 'dry')} style={{ marginLeft: 4 }}>{p.cat}</span></div></td>
                  <td className="lead-bar-wrap"><div className="lead-bar"><i style={{ width: (p.tonnage / maxT * 100) + '%', background: p.color }} /></div></td>
                  <td className="lead-num">{fmtNum(p.tonnage)} MT</td>
                  <td className="lead-sub">{fmtCompactUSD(p.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

window.Analytics = Analytics;
