/* global React, ReactDOM, Sidebar, TopBar, ToastHost, Dashboard, VesselCalls, VesselCallDetail, Inspections, NewInspection, Invoices, Settings, Analytics, SEED_CALLS, SEED_INSPECTIONS, SEED_INVOICES, DEFAULT_SETTINGS, calcDues, calcCommission, rateForInspection */
const { useState: useStateApp, useCallback: useCallbackApp, useEffect: useEffectApp } = React;

const TITLES = {
  dashboard: 'Dashboard', 'vessel-calls': 'Vessel Calls', 'vessel-call-detail': 'Vessel Calls',
  inspections: 'Inspections', 'new-inspection': 'New Inspection', invoices: 'Invoices', analytics: 'Analytics', settings: 'Settings',
};

function App() {
  const [route, setRoute] = useStateApp({ screen: 'dashboard', params: {} });
  const [calls, setCalls] = useStateApp(SEED_CALLS);
  const [inspections, setInspections] = useStateApp(SEED_INSPECTIONS);
  const [invoices, setInvoices] = useStateApp(SEED_INVOICES);
  const [settings, setSettings] = useStateApp(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useStateApp([]);
  const [flashId, setFlashId] = useStateApp(null);
  const [mobileNav, setMobileNav] = useStateApp(false);

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

  const addCall = useCallbackApp((data) => {
    const id = 'vc-' + Date.now();
    const call = { id, ...data, berthDate: null, registered: new Date().toISOString().slice(0, 16) };
    setCalls((cs) => [call, ...cs]);
    return id;
  }, []);

  const deleteCall = useCallbackApp((id) => {
    setCalls((cs) => cs.filter((c) => c.id !== id));
    setInspections((is) => is.filter((i) => i.callId !== id));
    setInvoices((iv) => iv.filter((v) => v.callId !== id));
  }, []);

  const addInspection = useCallbackApp((data) => {
    const insNum = Math.max(0, ...inspections.map((i) => parseInt(i.reference.split('-')[2], 10) || 0)) + 1;
    const insId = 'in-' + Date.now();
    const inspection = {
      id: insId, reference: `INS-2026-${insNum.toString().padStart(4, '0')}`,
      callId: data.callId, vesselName: (calls.find((c) => c.id === data.callId) || {}).vesselName || '—',
      cargoType: data.cargoType, reconciledTonnage: data.reconciledTonnage,
      date: new Date().toISOString().slice(0, 16), status: data.status,
      liquid: data.liquid, dry: data.dry, jetty: data.jetty || null,
    };
    setInspections((is) => [inspection, ...is]);

    let invoice = null;
    let call = calls.find((c) => c.id === data.callId);
    if (data.status === 'completed') {
      setCalls((cs) => cs.map((c) => c.id === data.callId ? { ...c, status: 'completed', berthDate: c.berthDate || new Date().toISOString().slice(0, 10) } : c));
      call = { ...call, status: 'completed' };
      const invNum = Math.max(0, ...invoices.map((v) => parseInt(v.invoiceNo.split('-')[2], 10) || 0)) + 1;
      invoice = {
        id: 'iv-' + Date.now(), invoiceNo: `INV-2026-${invNum.toString().padStart(4, '0')}`,
        callId: data.callId, inspectionId: insId, vesselName: call.vesselName, callRef: call.reference,
        status: 'unpaid', issued: new Date().toISOString().slice(0, 16),
        due: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
      };
      setInvoices((iv) => [invoice, ...iv]);
    }
    return { inspection, invoice, call };
  }, [calls, inspections, invoices]);

  const updateSettings = useCallbackApp((s) => setSettings(s), []);

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
