/* global React, ReactDOM, Sidebar, TopBar, ToastHost, Dashboard, VesselCalls, VesselCallDetail, Inspections, NewInspection, Invoices, Settings, Analytics, calcDues, calcCommission, rateForInspection, PORT_STORE_KEY, apiActive, bootPortData, savePortData, applyInspection, apiCreateCall, apiCreateInspection, apiDeleteCall, apiUpdateSettings, fetchStateIfChanged */
const { useState: useStateApp, useCallback: useCallbackApp, useEffect: useEffectApp, useRef: useRefApp } = React;

// ---- Boot: probe the Python backend, fall back to localStorage ----
function App() {
  const [boot, setBoot] = useStateApp(null);
  useEffectApp(() => { bootPortData().then(setBoot); }, []);
  if (!boot) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', color: 'var(--slate)', fontSize: 14 }}>
        Loading port data…
      </div>
    );
  }
  return <PortApp boot={boot} />;
}

const TITLES = {
  dashboard: 'Dashboard', 'vessel-calls': 'Vessel Calls', 'vessel-call-detail': 'Vessel Calls',
  inspections: 'Inspections', 'new-inspection': 'New Inspection', invoices: 'Invoices', analytics: 'Analytics', settings: 'Settings',
};

function PortApp({ boot }) {
  const [route, setRoute] = useStateApp({ screen: 'dashboard', params: {} });
  const [calls, setCalls] = useStateApp(boot.calls);
  const [inspections, setInspections] = useStateApp(boot.inspections);
  const [invoices, setInvoices] = useStateApp(boot.invoices);
  const [settings, setSettings] = useStateApp(boot.settings);
  const [toasts, setToasts] = useStateApp([]);
  const [flashId, setFlashId] = useStateApp(null);
  const [mobileNav, setMobileNav] = useStateApp(false);
  const revRef = useRefApp(boot.rev || 0);

  const applyServerState = useCallbackApp((d) => {
    revRef.current = d.rev || 0;
    setCalls(d.calls); setInspections(d.inspections); setInvoices(d.invoices); setSettings(d.settings);
  }, []);

  // Fallback mode only: write-through persistence to localStorage
  // (in backend mode the server owns the data — savePortData no-ops)
  useEffectApp(() => {
    savePortData({ calls, inspections, invoices, settings });
  }, [calls, inspections, invoices, settings]);

  // Live sync. Backend mode: poll the server rev so captures from the
  // mobile app appear here across devices. Fallback: storage event.
  useEffectApp(() => {
    if (apiActive()) {
      const id = setInterval(async () => {
        const d = await fetchStateIfChanged(revRef.current);
        if (d) applyServerState(d);
      }, 5000);
      return () => clearInterval(id);
    }
    const onStorage = (e) => {
      if (e.key !== PORT_STORE_KEY || !e.newValue) return;
      try {
        const d = JSON.parse(e.newValue);
        if (!d || !Array.isArray(d.calls)) return;
        setCalls(d.calls); setInspections(d.inspections); setInvoices(d.invoices); setSettings(d.settings);
      } catch (err) { /* ignore malformed writes */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [applyServerState]);

  const toast = useCallbackApp((message, type = 'success') => {
    const id = 't' + Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, message, type }]);
  }, []);
  const dismissToast = useCallbackApp((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const navigate = useCallbackApp((screen, params = {}) => {
    setRoute({ screen, params });
    document.querySelector('.content')?.scrollTo(0, 0);
    if (params.flash) {
      setFlashId(params.flash);
      setTimeout(() => setFlashId(null), 2400);
    }
  }, []);

  const inspectionsForCall = useCallbackApp((callId) => inspections.filter((i) => i.callId === callId).sort((a, b) => new Date(b.date) - new Date(a.date)), [inspections]);
  const invoiceForCall = useCallbackApp((callId) => invoices.find((iv) => iv.callId === callId), [invoices]);

  const financialsForCall = useCallbackApp((call) => {
    if (!call) return null;
    // Dues require a completed inspection — the applicable rate depends on
    // the cargo type and (for liquid) the jetty recorded during inspection.
    const insp = inspections.find((i) => i.callId === call.id && i.status === 'completed');
    if (!insp) return null;
    const rate = rateForInspection(insp, settings);
    if (!rate) return null;
    const dues = calcDues(call.nrt, rate);
    const c = calcCommission(dues, settings);
    return { dues, rate, commissionUsd: c.usd, commissionNgn: c.ngn, inspection: insp };
  }, [inspections, settings]);

  const addCall = useCallbackApp(async (data) => {
    const res = await apiCreateCall(data); // POST /api/vessel-calls (or local)
    if (res.rev) revRef.current = res.rev;
    setCalls((cs) => [res.call, ...cs]);
    return res.call.id;
  }, []);

  const deleteCall = useCallbackApp(async (id) => {
    const res = await apiDeleteCall(id); // DELETE /api/vessel-calls/:id (or local)
    if (res.rev) revRef.current = res.rev;
    setCalls((cs) => cs.filter((c) => c.id !== id));
    setInspections((is) => is.filter((i) => i.callId !== id));
    setInvoices((iv) => iv.filter((v) => v.callId !== id));
  }, []);

  const addInspection = useCallbackApp(async (data) => {
    // POST /api/inspections — the server (or the local fallback engine)
    // numbers the inspection, completes the call and issues the invoice.
    const res = await apiCreateInspection({ calls, inspections, invoices, settings }, data);
    if (res.rev) revRef.current = res.rev;
    setInspections((is) => [res.inspection, ...is]);
    if (res.call) setCalls((cs) => cs.map((c) => (c.id === res.call.id ? res.call : c)));
    if (res.invoice) setInvoices((iv) => [res.invoice, ...iv]);
    return { inspection: res.inspection, invoice: res.invoice, call: res.call };
  }, [calls, inspections, invoices, settings]);

  const updateSettings = useCallbackApp(async (s) => {
    const res = await apiUpdateSettings(s); // PUT /api/settings (or local)
    if (res.rev) revRef.current = res.rev;
    setSettings(s);
  }, []);

  const store = {
    route, navigate, calls, inspections, invoices, settings, flashId,
    toast, addCall, deleteCall, addInspection, updateSettings,
    financialsForCall, inspectionsForCall, invoiceForCall,
  };

  let Screen;
  switch (route.screen) {
    case 'dashboard': Screen = <Dashboard store={store} />; break;
    case 'vessel-calls': Screen = <VesselCalls store={store} />; break;
    case 'vessel-call-detail': Screen = <VesselCallDetail store={store} />; break;
    case 'inspections': Screen = <Inspections store={store} />; break;
    case 'new-inspection': Screen = <NewInspection store={store} />; break;
    case 'invoices': Screen = <Invoices store={store} />; break;
    case 'analytics': Screen = <Analytics store={store} />; break;
    case 'settings': Screen = <Settings store={store} />; break;
    default: Screen = <Dashboard store={store} />;
  }

  const navActive = route.screen === 'vessel-call-detail' ? 'vessel-calls'
    : route.screen === 'new-inspection' ? 'inspections' : route.screen;

  return (
    <div className="app">
      <Sidebar active={navActive} navigate={navigate} mobileOpen={mobileNav} closeMobile={() => setMobileNav(false)} />
      <div className={'drawer-backdrop-mobile ' + (mobileNav ? 'open' : '')} onClick={() => setMobileNav(false)} />
      <div className="main">
        <TopBar title={TITLES[route.screen] || 'Calabar Port'} portName={settings.portName} onHamburger={() => setMobileNav(true)} />
        <main className="content scroll-host">
          {Screen}
        </main>
      </div>
      <ToastHost toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
