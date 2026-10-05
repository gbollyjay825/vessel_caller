import { useEffect, useRef, useState, type FormEvent } from "react";
import type { VesselCall } from "../types";
import { Icon } from "../components/Icon";
import { ErrorMessage, FormField } from "./shared";
import { dateLabel, localDateTime } from "./helpers";
import { AGENCY_ROLES, CARGO_CATEGORIES, CARGO_TYPES, UNIT_LABELS, basisFor, cargoLine, categoryFor, defaultMethod, templateLines, unitsFor, type CargoTemplateType } from "./cargoTemplates";
import { groupVesselCalls } from "./voyages";
import type { AgencyProfile } from "./agencyDirectory";
import type { CargoLineInput, ParticipantInput, PlanInput, QuantityUnit } from "./types";
import "../styles/measurement-entry.css";

type CargoRow = { id: number; included: boolean; edited: boolean; line: CargoLineInput };
type Details = Pick<PlanInput, "title" | "scheduledAt" | "location" | "method" | "stage" | "scope" | "leadSurveyor" | "notes"> & { endsAt: string };
type VoyageChoice = { vesselKey: string; callId: string };
type PlanFormProps = { calls: VesselCall[]; callId?: string; agencyCatalog?: AgencyProfile[]; canRegisterVessel?: boolean; canManageAgencies?: boolean; onCreateAgency?: (input: Pick<AgencyProfile, "name" | "role" | "representative">) => Promise<AgencyProfile>; onSave: (value: PlanInput) => Promise<unknown>; onCancel: () => void };
const STEPS = ["Vessel & voyage", "Owner declaration", "Agencies"];
const typeIcons = { Containers: "package", Bulk: "gauge", Tanker: "droplet", "General cargo": "clipboard", Vehicles: "route", Mixed: "compass" };
const categoryLabel = (category: string) => category === "Liquid" ? "Tanker / liquid cargo" : category;

export function PlanForm({ calls, callId: initialCallId, agencyCatalog = [], canRegisterVessel = false, canManageAgencies = false, onCreateAgency, onSave, onCancel }: PlanFormProps) {
  const vessels = groupVesselCalls(calls.filter(call => call.status !== "cancelled"));
  const [voyage, setVoyage] = useState<VoyageChoice>(() => ({ vesselKey: vessels.find(vessel => vessel.calls.some(call => call.id === initialCallId))?.key ?? "", callId: initialCallId ?? "" }));
  const [pendingVoyage, setPendingVoyage] = useState<VoyageChoice | null>(null);
  const [step, setStep] = useState(0);
  const [declarationReference, setDeclarationReference] = useState("");
  const [cargoType, setCargoType] = useState<CargoTemplateType>("Bulk");
  const [pendingType, setPendingType] = useState<CargoTemplateType | null>(null);
  const [details, setDetails] = useState<Partial<Details>>({ scheduledAt: localDateTime(), endsAt: "", leadSurveyor: "To be assigned", notes: "" });
  const [arrangementsEdited, setArrangementsEdited] = useState(false);
  const [rows, setRows] = useState<CargoRow[]>([{ id: 1, included: true, edited: false, line: cargoLine() }]);
  const [selectedAgencyIds, setSelectedAgencyIds] = useState<string[]>([]);
  const [agencyDrafts, setAgencyDrafts] = useState<Record<string, ParticipantInput>>({});
  const [agencyCreationOpen, setAgencyCreationOpen] = useState(false);
  const [agencyCreationPending, setAgencyCreationPending] = useState(false);
  const [agencyCreationError, setAgencyCreationError] = useState<unknown>(null);
  const [newAgency, setNewAgency] = useState({ name: "", role: "Agent", representative: "" });
  const [customAgencyRole, setCustomAgencyRole] = useState(false);
  const [createdAgencies, setCreatedAgencies] = useState<AgencyProfile[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextRowId = useRef(2);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    setCreatedAgencies(current => current.some(agency => agencyCatalog.some(profile => profile.id === agency.id))
      ? current.filter(agency => !agencyCatalog.some(profile => profile.id === agency.id)) : current);
  }, [agencyCatalog]);
  const selectedVessel = vessels.find(vessel => vessel.key === voyage.vesselKey);
  const selectedCall = selectedVessel?.calls.find(call => call.id === voyage.callId);
  const includedRows = rows.filter(row => row.included);
  const sharedReference = declarationReference.trim();
  const lines = includedRows.map(row => ({ ...row.line, direction: "import", baselineReference: row.line.baselineReference.trim() || sharedReference }));
  const participants = selectedAgencyIds.map(id => agencyDrafts[id]);
  const catalog = [...agencyCatalog, ...createdAgencies.filter(agency => !agencyCatalog.some(profile => profile.id === agency.id))];
  const availableAgencies = [...catalog.filter(agency => agency.active).map(agency => ({ id: agency.id, ...agencyDrafts[agency.id] || agency })), ...selectedAgencyIds.filter(id => !catalog.some(agency => agency.id === id && agency.active)).map(id => ({ id, ...agencyDrafts[id] }))];
  const values: Details = {
    title: `${cargoType} discharge tally${selectedCall ? ` · ${selectedCall.vesselName} · ${selectedCall.reference}` : ""}`,
    method: defaultMethod(cargoType), stage: "Discharge",
    scope: lines.map(line => line.description).filter(Boolean).join("; ") || `${cargoType} cargo`,
    location: selectedCall?.berth ?? "", scheduledAt: "", endsAt: "", leadSurveyor: "", notes: "", ...details,
  };
  const changeDetail = (key: keyof Details, value: string) => { setDetails(current => ({ ...current, [key]: value })); setArrangementsEdited(true); };
  const resetArrangements = () => { setDetails({ scheduledAt: localDateTime(), endsAt: "", leadSurveyor: "To be assigned", notes: "" }); setArrangementsEdited(false); };
  const updateRow = (id: number, patch: Partial<CargoLineInput>) => setRows(current => current.map(row => row.id === id ? { ...row, edited: true, line: { ...row.line, ...patch } } : row));
  const resetCargo = (type: CargoTemplateType) => setRows(templateLines(type).map((line, index) => ({ id: nextRowId.current++, included: index === 0, edited: false, line })));
  const applyTemplate = (type: CargoTemplateType) => { resetCargo(type); setCargoType(type); setPendingType(null); };
  const selectType = (type: CargoTemplateType) => {
    if (type === cargoType) return;
    if (type === "Mixed") { setCargoType(type); setPendingType(null); return; }
    if (rows.some(row => row.edited)) setPendingType(type); else applyTemplate(type);
  };
  const changeVoyage = (choice: VoyageChoice) => {
    if (choice.callId === voyage.callId && choice.vesselKey === voyage.vesselKey) return;
    if (rows.some(row => row.edited) || declarationReference.trim() || arrangementsEdited) setPendingVoyage(choice);
    else { setVoyage(choice); setPendingVoyage(null); resetArrangements(); }
  };
  const clearAndChangeVoyage = () => {
    if (!pendingVoyage) return;
    resetCargo(cargoType); setDeclarationReference(""); setPendingType(null); setVoyage(pendingVoyage); setPendingVoyage(null);
    resetArrangements();
  };
  const addItem = (category = categoryFor(cargoType)) => {
    const id = nextRowId.current++;
    setRows(current => [...current, { id, included: true, edited: true, line: cargoLine(category) }]);
  };
  const setCategory = (row: CargoRow, category: string) => {
    const unit = unitsFor(category)[0];
    updateRow(row.id, { category, unit, basis: row.line.basis === basisFor(row.line.category, row.line.unit) ? basisFor(category, unit) : row.line.basis, containerSize: "", loadStatus: "" });
    if (category !== categoryFor(cargoType)) setCargoType("Mixed");
  };
  const changeUnit = (row: CargoRow, unit: QuantityUnit) => updateRow(row.id, { unit, basis: row.line.basis === basisFor(row.line.category, row.line.unit) ? basisFor(row.line.category, unit) : row.line.basis });
  const selectAgency = (agency: typeof availableAgencies[number], checked: boolean) => {
    if (checked) {
      setAgencyDrafts(current => current[agency.id] ? current : { ...current, [agency.id]: { name: agency.name, role: agency.role, representative: agency.representative, requiredSubmission: true, requiredApproval: true } });
      setSelectedAgencyIds(current => [...current, agency.id]);
    } else setSelectedAgencyIds(current => current.filter(id => id !== agency.id));
  };
  const createAgency = async () => {
    if (!onCreateAgency || !canManageAgencies || agencyCreationPending || !newAgency.name.trim() || !newAgency.role.trim()) return;
    setAgencyCreationPending(true); setAgencyCreationError(null);
    try {
      const agency = await onCreateAgency({ name: newAgency.name.trim(), role: newAgency.role.trim(), representative: newAgency.representative.trim() });
      setCreatedAgencies(current => [...current.filter(profile => profile.id !== agency.id), agency]);
      setAgencyDrafts(current => ({ ...current, [agency.id]: { name: agency.name, role: agency.role, representative: agency.representative, requiredSubmission: true, requiredApproval: true } }));
      setSelectedAgencyIds(current => current.includes(agency.id) ? current : [...current, agency.id]);
      setAgencyCreationOpen(false); setNewAgency({ name: "", role: "Agent", representative: "" }); setCustomAgencyRole(false);
    } catch (failure) { setAgencyCreationError(failure); }
    finally { setAgencyCreationPending(false); }
  };
  const updateAgency = (id: string, patch: Partial<ParticipantInput>) => setAgencyDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  const blocked = pending || agencyCreationOpen || agencyCreationPending || !!pendingVoyage || !!pendingType || (step === 0 && !selectedCall) || (step === 1 && !includedRows.length) || (step === 2 && !participants.length);
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) return;
    const form = event.currentTarget;
    const invalid = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:invalid, select:invalid, textarea:invalid");
    if (invalid) { const disclosure = invalid.closest("details"); if (disclosure) disclosure.open = true; invalid.reportValidity(); invalid.focus(); return; }
    setError(null);
    if (step < 2) { setStep(current => current + 1); return; }
    if (!selectedCall) { setStep(0); return; }
    if (!includedRows.length) { setStep(1); return; }
    if (!participants.length) { setStep(2); return; }
    setPending(true);
    try { await onSave({ ...values, leadSurveyor: values.leadSurveyor.trim() || "To be assigned", callId: selectedCall.id, scheduledAt: new Date(values.scheduledAt).toISOString(), endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : null, lines, participants }); }
    catch (failure) { setError(failure); }
    finally { setPending(false); }
  };

  return <form className="measurement-form measurement-entry entry-wizard" noValidate onSubmit={event => void handleSubmit(event)}>
    <ol className="entry-steps" aria-label="Plan setup steps">{STEPS.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "complete" : ""} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Icon name="check" size={14} /> : index + 1}</span><strong>{label}</strong></li>)}</ol>
    <fieldset disabled={pending}>
      <section className="entry-section" aria-labelledby="entry-step-heading">
        <div className="entry-section-title"><div><p className="entry-step-count">Step {step + 1} of 3</p><h2 ref={heading} tabIndex={-1} id="entry-step-heading">{STEPS[step]}</h2><p>{[
          "Choose the vessel, then the voyage receiving this declaration.",
          "What is arriving on this voyage? Copy the vessel owner's import declaration. Agency readings are collected separately after setup.",
          "Create or select the agencies that will report this vessel’s load.",
        ][step]}</p></div></div>
        {step > 0 && selectedCall && <div className="entry-voyage-context"><Icon name="ship" size={16} /><strong>{selectedCall.vesselName}</strong><span>{selectedCall.reference}</span><span>Import / discharge</span></div>}
        {step === 0 && <>
          <div className="measurement-form-grid entry-voyage-selectors"><FormField label="Vessel"><select required value={voyage.vesselKey} onChange={event => { const vessel = vessels.find(item => item.key === event.target.value); changeVoyage({ vesselKey: event.target.value, callId: vessel?.calls.length === 1 ? vessel.calls[0].id : "" }); }}><option value="">Select a vessel</option>{vessels.map(vessel => <option value={vessel.key} key={vessel.key}>{vessel.name}{vessel.flag ? ` · ${vessel.flag}` : ""}</option>)}</select></FormField>
            <FormField label="Voyage"><select required disabled={!selectedVessel} value={voyage.callId} onChange={event => changeVoyage({ ...voyage, callId: event.target.value })}><option value="">Select a voyage</option>{selectedVessel?.calls.map(call => <option value={call.id} key={call.id}>{call.reference}{call.eta ? ` · ETA ${dateLabel(call.eta)}` : ""}{call.berth ? ` · ${call.berth}` : ""}</option>)}</select></FormField></div>
          {canRegisterVessel && <p className="measurement-help"><a className="link-btn" href="/app/vessel-calls?register" target="_blank" rel="noopener noreferrer">Register vessel / voyage <Icon name="external" size={14} /></a></p>}
          {pendingVoyage && <div className="entry-switch-notice" role="alert"><strong>This declaration belongs to the current voyage.</strong><p>Changing voyages clears the owner declaration and its references. Your selected agencies are retained. Voyage details are reset for the new voyage.</p><div className="measurement-inline-actions"><button type="button" className="btn btn-secondary" onClick={clearAndChangeVoyage}>Clear declaration and change voyage</button><button type="button" className="link-btn" onClick={() => setPendingVoyage(null)}>Keep current voyage</button></div></div>}
          {selectedCall ? <div className="entry-vessel-summary"><div className="entry-vessel-name"><Icon name="ship" size={26} /><div><strong>{selectedCall.vesselName}</strong><span>{selectedCall.reference}</span></div></div><dl>{[["Vessel type", selectedCall.type], ["Flag", selectedCall.flag], ["Net registered tonnage", selectedCall.nrt == null ? null : selectedCall.nrt.toLocaleString()], ["ETA", selectedCall.eta ? dateLabel(selectedCall.eta) : null], ["Berth", selectedCall.berth]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not recorded"}</dd></div>)}</dl></div> : <div className="entry-empty-state"><Icon name="ship" size={28} /><p>{vessels.length ? "The same vessel can have several voyages. Select the trip you are preparing." : "No active vessel voyages are available. Register a vessel call before preparing its declaration."}</p></div>}
          {selectedCall && <details className="entry-advanced entry-voyage-details"><summary>Voyage details (optional)</summary><p className="measurement-help">The voyage berth and current time are used by default. Leave the lead surveyor as “To be assigned” if not yet known.</p><div className="measurement-form-grid">
            <FormField label="Terminal / berth"><input value={values.location} placeholder="Not recorded" onChange={event => changeDetail("location", event.target.value)} /></FormField>
            <FormField label="Lead surveyor"><input value={values.leadSurveyor} placeholder="To be assigned" onChange={event => changeDetail("leadSurveyor", event.target.value)} /></FormField>
            <FormField label="Scheduled start" hint="Dates use your local time zone."><input required type="datetime-local" value={values.scheduledAt} onChange={event => changeDetail("scheduledAt", event.target.value)} /></FormField>
            <FormField label="Scheduled end (optional)"><input type="datetime-local" min={values.scheduledAt} value={values.endsAt} onChange={event => changeDetail("endsAt", event.target.value)} /></FormField>
            <FormField label="Voyage notes (optional)"><textarea value={values.notes} onChange={event => changeDetail("notes", event.target.value)} /></FormField>
          </div></details>}
        </>}

        {step === 1 && <>
          <fieldset className="entry-cargo-types"><legend>Type of cargo</legend><div>{CARGO_TYPES.map(type => <label className={cargoType === type ? "selected" : ""} key={type}><input type="radio" name="cargo-template" checked={cargoType === type} onChange={() => selectType(type)} /><Icon name={typeIcons[type]} size={19} /><span>{type}</span></label>)}</div></fieldset>
          {pendingType && <div className="entry-switch-notice" role="alert"><strong>Keep the cargo values you entered?</strong><p>Switching to {pendingType} replaces the current cargo items.</p><div className="measurement-inline-actions"><button type="button" className="btn btn-secondary" onClick={() => { setCargoType("Mixed"); setPendingType(null); }}>Keep items and use Mixed</button><button type="button" className="btn btn-secondary" onClick={() => applyTemplate(pendingType)}>Replace cargo items</button><button type="button" className="link-btn" onClick={() => setPendingType(null)}>Keep current cargo type</button></div></div>}
          <div className="entry-sheet-help"><Icon name="info" size={17} /><p><strong>Owner declaration: blank = unknown. 0 = declared NIL.</strong> Count, tonnes and m³ stay separate.</p></div>
          {cargoType === "Tanker" && <p className="entry-product-help">Identify the cargo product, such as petroleum, chemicals or gas. Record mass in tonnes or volume in m³ as separate cargo items; no conversion is assumed.</p>}
          <div className="entry-shared-reference"><FormField label="Vessel declaration reference" hint="Applies to every selected cargo item unless it has its own reference."><input aria-label="Vessel declaration reference" value={declarationReference} placeholder="Manifest / bill of lading reference" onChange={event => setDeclarationReference(event.target.value)} /></FormField></div>
          <div className="entry-direction"><div className="entry-direction-heading"><h3><Icon name="download" size={17} />Import / discharge</h3><span>{includedRows.length} {cargoType === "Containers" ? includedRows.length === 1 ? "container category" : "container categories" : includedRows.length === 1 ? "cargo item" : "cargo items"} selected</span></div>
            <div className="entry-sheet-scroll"><table className={`entry-cargo-table${cargoType === "Containers" || cargoType === "Vehicles" ? " entry-container-table" : ""}`}><caption className="entry-sr-only">Import owner declaration</caption><thead><tr><th scope="col">Use</th>{cargoType === "Containers" || cargoType === "Vehicles" ? <th scope="col" colSpan={2}>{cargoType === "Containers" ? "Container size / load status" : "Vehicle type"}</th> : <><th scope="col">Cargo item</th><th scope="col">Category</th></>}<th scope="col">Unit</th><th scope="col">Declared quantity</th><th scope="col">Reference override</th><th scope="col"><span className="entry-sr-only">Remove</span></th></tr></thead><tbody>{rows.map((row, index) => {
              const line = row.line, number = index + 1, knownQuantity = line.manifestQuantity !== null;
              const identity = line.category === "Container" && line.containerSize && line.loadStatus ? `${line.containerSize} ft · ${line.loadStatus === "laden" ? "Laden" : "Empty"}` : line.description || categoryLabel(line.category);
              const compact = (cargoType === "Containers" && line.category === "Container" && !!line.containerSize && !!line.loadStatus) || (cargoType === "Vehicles" && line.category === "Vehicle" && !!line.description);
              const includeCell = <td className="entry-include-cell"><label><input type="checkbox" checked={row.included} aria-label={`Include cargo item ${number} · ${identity}`} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, included: event.target.checked, edited: true } : item))} /><span className="entry-row-number">{number}</span></label></td>;
              const removeCell = <td><button type="button" className="icon-btn" aria-label={`Remove cargo item ${number}`} onClick={() => setRows(current => current.filter(item => item.id !== row.id))}><Icon name="trash" size={16} /></button></td>;
              if (!row.included) return <tr key={row.id} className="entry-row-excluded">{includeCell}<td colSpan={2} className="entry-cargo-cell entry-excluded-label"><strong>{identity}</strong><small className="entry-excluded-mobile-unit">{UNIT_LABELS[line.unit]} · Not selected</small></td><td className="entry-excluded-unit">{UNIT_LABELS[line.unit]}</td><td colSpan={2} className="entry-excluded-state">Not selected{knownQuantity && <small>Entered declaration retained</small>}</td>{removeCell}</tr>;
              const descriptionField = <FormField label={`Cargo description ${number}`}><input required value={line.description} placeholder={line.category === "Liquid" ? "Product, e.g. petroleum, chemicals or gas" : line.category === "Vehicle" ? "Vehicle type" : "Commodity / parcel"} onChange={event => updateRow(row.id, { description: event.target.value })} /></FormField>;
              const basisField = <FormField label={`Quantity basis ${number}`}><input required value={line.basis} onChange={event => updateRow(row.id, { basis: event.target.value })} /></FormField>;
              const containerFields = line.category === "Container" && <div className="entry-container-context"><FormField label={`Container size ${number}`}><select required value={line.containerSize} onChange={event => updateRow(row.id, { containerSize: event.target.value })}><option value="">Size</option>{["20", "40", "45"].map(size => <option value={size} key={size}>{size} ft</option>)}</select></FormField><FormField label={`Load status ${number}`}><select required value={line.loadStatus} onChange={event => updateRow(row.id, { loadStatus: event.target.value })}><option value="">Loading state</option><option value="laden">Laden</option><option value="empty">Empty</option></select></FormField></div>;
              const categoryField = <FormField label={`Category ${number}`}><select disabled={knownQuantity} value={line.category} onChange={event => setCategory(row, event.target.value)}>{CARGO_CATEGORIES.map(category => <option value={category} key={category}>{categoryLabel(category)}</option>)}</select></FormField>;
              return <tr key={row.id} className={compact ? "entry-container-preset" : ""}>{includeCell}
                {compact ? <td colSpan={2} className="entry-cargo-cell"><strong className="entry-preset-title">{identity}</strong><details className="entry-cargo-details"><summary aria-label={`Cargo details for item ${number}`}>Cargo details</summary><div>{descriptionField}{containerFields}{basisField}{categoryField}</div></details></td> : <><td className="entry-cargo-cell">{descriptionField}{containerFields}<details className="entry-cargo-details"><summary aria-label={`Quantity basis for item ${number}`}>Quantity basis</summary><div>{basisField}</div></details></td><td>{categoryField}</td></>}
                <td><FormField label={`Unit ${number}`}><select disabled={knownQuantity || unitsFor(line.category).length === 1} value={line.unit} onChange={event => changeUnit(row, event.target.value as QuantityUnit)}>{unitsFor(line.category).map(unit => <option value={unit} key={unit}>{UNIT_LABELS[unit]}</option>)}</select></FormField>{knownQuantity && !compact && <small className="entry-unit-note">Clear the quantity to change its category or unit.</small>}</td>
                <td><FormField label={`Manifest quantity ${number}`}><input type="number" min="0" step={line.unit === "count" ? "1" : "0.001"} value={line.manifestQuantity ?? ""} placeholder="Unknown" onChange={event => updateRow(row.id, { manifestQuantity: event.target.value === "" ? null : event.target.value })} /></FormField><small className={`entry-declaration-state${knownQuantity && Number(line.manifestQuantity) === 0 ? " nil" : ""}`}>{!knownQuantity ? "Unknown" : Number(line.manifestQuantity) === 0 ? "NIL declared" : UNIT_LABELS[line.unit]}</small></td>
                <td className="entry-reference-cell"><FormField label={`Manifest / baseline reference ${number}`}><input required={knownQuantity && !sharedReference} value={line.baselineReference} placeholder={sharedReference ? `Using ${sharedReference}` : knownQuantity ? "Required for declaration" : "Optional until known"} onChange={event => updateRow(row.id, { baselineReference: event.target.value })} /></FormField></td>{removeCell}</tr>;
            })}</tbody></table></div>
          </div>
          {cargoType === "Mixed" ? <div className="entry-add-categories"><span>Add a cargo item</span>{CARGO_CATEGORIES.map(category => <button className="btn btn-secondary" type="button" key={category} onClick={() => addItem(category)}>Add {category === "Liquid" ? "Tanker" : category}</button>)}</div> : <button className="btn btn-secondary" type="button" onClick={() => addItem()}><Icon name="plus" size={16} />Add cargo item</button>}
        </>}

        {step === 2 && <>
          <p className="measurement-help">The agency directory is saved in this browser for your organisation. Entries are not shared with other browsers or devices.</p>
          <div className="entry-agency-toolbar"><p>Each agency will report its own reading after this voyage sheet is created.</p><div className="measurement-inline-actions">{canManageAgencies && onCreateAgency && <button type="button" className="btn btn-secondary" disabled={agencyCreationOpen} onClick={() => { setAgencyCreationOpen(true); setAgencyCreationError(null); }}><Icon name="plus" size={15} />Create agency</button>}{canManageAgencies && <a className="link-btn" href="/app/settings/agencies" target="_blank" rel="noopener noreferrer">Manage agencies <Icon name="external" size={14} /></a>}</div></div>
          {agencyCreationOpen && <div className="entry-inline-agency" role="group" aria-labelledby="new-agency-heading"><h3 id="new-agency-heading">Create agency</h3><fieldset disabled={agencyCreationPending}><div className="measurement-form-grid">
            <FormField label="Agency name"><input value={newAgency.name} onChange={event => setNewAgency(current => ({ ...current, name: event.target.value }))} /></FormField>
            <FormField label="Agency role"><select value={customAgencyRole ? "custom" : newAgency.role} onChange={event => { const custom = event.target.value === "custom"; setCustomAgencyRole(custom); setNewAgency(current => ({ ...current, role: custom ? "" : event.target.value })); }}>{AGENCY_ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}<option value="custom">Other role</option></select></FormField>
            {customAgencyRole && <FormField label="Other agency role"><input value={newAgency.role} onChange={event => setNewAgency(current => ({ ...current, role: event.target.value }))} /></FormField>}
            <FormField label="Default representative (optional)"><input value={newAgency.representative} onChange={event => setNewAgency(current => ({ ...current, representative: event.target.value }))} /></FormField>
          </div><p className="measurement-help">The agency is selected for this voyage after it is saved. Name its attending representative before continuing to load reporting.</p></fieldset><ErrorMessage error={agencyCreationError} /><div className="measurement-inline-actions"><button type="button" className="btn btn-secondary" disabled={agencyCreationPending} onClick={() => { setAgencyCreationOpen(false); setAgencyCreationError(null); }}>Cancel agency</button><button type="button" className="btn btn-primary" disabled={agencyCreationPending || !newAgency.name.trim() || !newAgency.role.trim()} onClick={() => void createAgency()}>{agencyCreationPending ? "Saving agency…" : "Save agency"}</button></div></div>}

          {availableAgencies.length ? <div className="entry-agency-catalog">{availableAgencies.map(agency => {
            const selected = selectedAgencyIds.includes(agency.id), draft = agencyDrafts[agency.id];
            const unavailable = !catalog.some(profile => profile.id === agency.id && profile.active);
            return <div className={`entry-agency-card${selected ? " selected" : ""}`} key={agency.id}><label className="entry-agency-choice"><input type="checkbox" aria-label={`Select agency ${agency.name}`} checked={selected} onChange={event => selectAgency(agency, event.target.checked)} /><span><strong>{agency.name}</strong><small>{agency.role}{agency.representative ? ` · ${agency.representative}` : ""}</small></span></label>{selected && <div className="entry-agency-options">{unavailable && <p className="entry-agency-unavailable" role="status">This agency is no longer active in the directory. Its saved selection is retained for this voyage; deselect it if it will not participate.</p>}<FormField label={`Representative for ${draft.name}`} hint="Change only for this voyage if someone else is attending."><input aria-label={`Representative for ${draft.name}`} required value={draft.representative} onChange={event => updateAgency(agency.id, { representative: event.target.value })} /></FormField></div>}</div>;
          })}</div> : <div className="entry-empty-state"><Icon name="users" size={28} /><strong>No agencies in the directory yet</strong><p>{canManageAgencies ? (onCreateAgency ? "Create an agency here or open Settings, then select it for this voyage. This sheet stays open in this tab." : "Add agencies in Settings, then return here to select them. This sheet stays open in this tab.") : "Ask an administrator to add agencies in this browser’s directory, then return to this step. Agencies saved on another device will not appear here."}</p></div>}
          <p className="measurement-help">{participants.length} {participants.length === 1 ? "agency" : "agencies"} selected. Saved names, roles and representatives are copied into this voyage sheet; directory records stay unchanged.</p>
          <details className="entry-review-details"><summary>Review declaration and agencies</summary><ul>{lines.map((line, index) => <li key={index}><span>{line.description}</span><strong>{line.manifestQuantity === null ? "Unknown" : Number(line.manifestQuantity) === 0 ? "NIL (0)" : line.manifestQuantity} {UNIT_LABELS[line.unit]}</strong><small>{line.baselineReference || "No reference"}</small></li>)}</ul><ul>{participants.map((party, index) => <li key={index}><span>{party.name}</span><strong>{party.role}</strong><small>{party.representative}</small></li>)}</ul></details>
          <p className="entry-next-note"><Icon name="info" size={17} />Next: report the vessel load for each selected agency. Each reading is kept separately from the owner’s declaration.</p>
        </>}

      </section>
    </fieldset>
    <ErrorMessage error={error} />
    <div className="entry-wizard-actions"><button className="link-btn" type="button" disabled={pending || agencyCreationPending} onClick={onCancel}>Cancel</button><div>{step > 0 && <button className="btn btn-secondary" type="button" disabled={pending || agencyCreationPending} onClick={() => { setAgencyCreationOpen(false); setStep(current => current - 1); setError(null); }}>Previous</button>}<button className="btn btn-primary" type="submit" disabled={blocked}>{pending ? "Saving…" : step === 2 ? "Create voyage sheet" : "Continue"}{step < 2 && <Icon name="arrowRight" size={16} />}</button></div></div>
  </form>;
}
