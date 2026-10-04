import { useRef, useState } from "react";
import type { VesselCall } from "../types";
import { Icon } from "../components/Icon";
import { ActionForm, FormField } from "./shared";
import { dateLabel, localDateTime } from "./helpers";
import { AGENCY_ROLES, CARGO_CATEGORIES, CARGO_TYPES, UNIT_LABELS, basisFor, cargoLine, categoryFor, defaultMethod, templateLines, unitsFor, type CargoTemplateType } from "./cargoTemplates";
import type { CargoLineInput, ParticipantInput, PlanInput, QuantityUnit } from "./types";
import "../styles/measurement-entry.css";

type CargoRow = { id: number; included: boolean; edited: boolean; line: CargoLineInput };
type PartyRow = { id: number; customRole: boolean; party: ParticipantInput };
type Details = Pick<PlanInput, "title" | "scheduledAt" | "location" | "method" | "stage" | "scope" | "leadSurveyor" | "notes"> & { endsAt: string };
const blankParty = (role = "Agent"): ParticipantInput => ({ name: "", role, representative: "", requiredSubmission: true, requiredApproval: true });
const typeIcons = { Containers: "package", Bulk: "gauge", Tanker: "droplet", "General cargo": "clipboard", Vehicles: "route", Mixed: "compass" };

export function PlanForm({ calls, callId: initialCallId, onSave, onCancel }: { calls: VesselCall[]; callId?: string; onSave: (value: PlanInput) => Promise<unknown>; onCancel: () => void }) {
  const [callId, setCallId] = useState(initialCallId ?? "");
  const [declarationReference, setDeclarationReference] = useState("");
  const [cargoType, setCargoType] = useState<CargoTemplateType>("Bulk");
  const [pendingType, setPendingType] = useState<CargoTemplateType | null>(null);
  const [details, setDetails] = useState<Partial<Details>>({ scheduledAt: localDateTime(), endsAt: "", leadSurveyor: "", notes: "" });
  const [rows, setRows] = useState<CargoRow[]>([{ id: 1, included: true, edited: false, line: cargoLine() }]);
  const [parties, setParties] = useState<PartyRow[]>([{ id: 1, customRole: false, party: blankParty() }]);
  const nextRowId = useRef(2);
  const nextPartyId = useRef(2);
  const selectedCall = calls.find(call => call.id === callId && call.status !== "cancelled");
  const includedRows = rows.filter(row => row.included);
  const sharedReference = declarationReference.trim();
  const lines = includedRows.map(row => ({ ...row.line, baselineReference: row.line.baselineReference.trim() || sharedReference }));
  const directions = new Set(lines.map(line => line.direction));
  const values: Details = {
    title: `${cargoType} measurement${selectedCall ? ` · ${selectedCall.vesselName}` : ""}`,
    method: defaultMethod(cargoType),
    stage: directions.size > 1 ? "Discharge and loading" : directions.has("export") ? "Loading" : "Discharge",
    scope: lines.map(line => line.description).filter(Boolean).join("; ") || `${cargoType} cargo`,
    location: selectedCall?.berth ?? "", scheduledAt: "", endsAt: "", leadSurveyor: "", notes: "",
    ...details,
  };
  const changeDetail = (key: keyof Details, value: string) => setDetails(current => ({ ...current, [key]: value }));
  const updateRow = (id: number, patch: Partial<CargoLineInput>) => setRows(current => current.map(row => row.id === id ? { ...row, edited: true, line: { ...row.line, ...patch } } : row));
  const updateParty = (id: number, patch: Partial<ParticipantInput>) => setParties(current => current.map(row => row.id === id ? { ...row, party: { ...row.party, ...patch } } : row));
  const applyTemplate = (type: CargoTemplateType) => {
    setRows(templateLines(type).map((line, index) => ({ id: nextRowId.current++, included: index === 0, edited: false, line })));
    setCargoType(type); setPendingType(null);
  };
  const selectType = (type: CargoTemplateType) => {
    if (type === cargoType) return;
    if (type === "Mixed") { setCargoType(type); setPendingType(null); return; }
    if (rows.some(row => row.edited)) setPendingType(type);
    else applyTemplate(type);
  };
  const addLine = (direction = "import", category = categoryFor(cargoType)) => {
    const id = nextRowId.current++;
    setRows(current => [...current, { id, included: true, edited: true, line: cargoLine(category, direction) }]);
  };
  const addParty = (role = "Agent") => {
    const id = nextPartyId.current++;
    setParties(current => [...current, { id, customRole: false, party: blankParty(role) }]);
  };
  const setCategory = (row: CargoRow, category: string) => {
    const unit = unitsFor(category)[0];
    updateRow(row.id, { category, unit, basis: row.line.basis === basisFor(row.line.category, row.line.unit) ? basisFor(category, unit) : row.line.basis, containerSize: "", loadStatus: "" });
    if (category !== categoryFor(cargoType)) setCargoType("Mixed");
  };
  const changeUnit = (row: CargoRow, unit: QuantityUnit) => updateRow(row.id, { unit, basis: row.line.basis === basisFor(row.line.category, row.line.unit) ? basisFor(row.line.category, unit) : row.line.basis });
  const submit = () => onSave({ ...values, callId, scheduledAt: new Date(values.scheduledAt).toISOString(), endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : null, lines, participants: parties.map(row => row.party) });

  return <ActionForm submit="Create measurement plan" onCancel={onCancel} disabled={!selectedCall || !includedRows.length || pendingType !== null} onSubmit={submit}>
    <div className="measurement-entry">
      <ol className="entry-flow" aria-label="Measurement workflow">
        <li><span>1</span><div><strong>Owner's baseline</strong><small>Declaration supplied by the vessel owner</small></div></li>
        <li><span>2</span><div><strong>Independent agency readings</strong><small>Each agency measures and submits its own figures</small></div></li>
        <li><span>3</span><div><strong>NPA reconciliation</strong><small>Compare the readings and agree the final result</small></div></li>
      </ol>
      <section className="entry-section" aria-labelledby="entry-vessel-heading">
        <div className="entry-section-title"><span>01</span><div><h2 id="entry-vessel-heading">Choose the vessel</h2><p>Select the vessel call for the owner declaration and the independent agency measurements.</p></div></div>
        <FormField label="Vessel call"><select required value={callId} onChange={event => setCallId(event.target.value)}><option value="">Select a vessel call</option>{calls.filter(call => call.status !== "cancelled").map(call => <option value={call.id} key={call.id}>{call.vesselName} · {call.reference}</option>)}</select></FormField>
        {selectedCall ? <div className="entry-vessel-summary"><div className="entry-vessel-name"><Icon name="ship" size={26} /><div><strong>{selectedCall.vesselName}</strong><span>{selectedCall.reference}</span></div></div><dl>{[["Vessel type", selectedCall.type], ["Flag", selectedCall.flag], ["Net registered tonnage", selectedCall.nrt == null ? null : selectedCall.nrt.toLocaleString()], ["ETA", selectedCall.eta ? dateLabel(selectedCall.eta) : null], ["Berth", selectedCall.berth]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not recorded"}</dd></div>)}</dl></div> : <p className="measurement-help">Vessel details will appear here after selection.</p>}
      </section>

      <section className="entry-section" aria-labelledby="entry-cargo-heading">
        <div className="entry-section-title"><span>02</span><div><h2 id="entry-cargo-heading">Vessel owner's baseline declaration</h2><p>Record the baseline declaration supplied by the vessel owner. Agency readings are entered separately after setup.</p></div></div>
        <fieldset className="entry-cargo-types"><legend>Type of cargo</legend><div>{CARGO_TYPES.map(type => <label className={cargoType === type ? "selected" : ""} key={type}><input type="radio" name="cargo-template" checked={cargoType === type} onChange={() => selectType(type)} /><Icon name={typeIcons[type]} size={19} /><span>{type}</span></label>)}</div></fieldset>
        {pendingType && <div className="entry-switch-notice" role="alert"><strong>Keep the cargo values you entered?</strong><p>Switching to {pendingType} replaces the current cargo rows. Your vessel, schedule and agencies stay as entered.</p><div className="measurement-inline-actions"><button type="button" className="btn btn-secondary" onClick={() => { setCargoType("Mixed"); setPendingType(null); }}>Keep rows and use Mixed</button><button type="button" className="btn btn-secondary" onClick={() => applyTemplate(pendingType)}>Replace cargo rows</button><button type="button" className="link-btn" onClick={() => setPendingType(null)}>Keep current cargo type</button></div></div>}
        <div className="entry-sheet-help"><Icon name="info" size={17} /><p><strong>Owner declaration: blank = unknown. 0 = declared NIL.</strong> Quantities are kept in their own units. Count, tonnes and m³ are never added together.</p></div>
        {cargoType === "Tanker" && <p className="entry-product-help">Identify the cargo product in each row, for example petroleum, chemicals or gas. Record mass in tonnes or volume in m³ on separate rows; no conversion is assumed.</p>}
        {cargoType === "Mixed" && <div className="entry-add-categories"><span>Add a cargo category</span>{CARGO_CATEGORIES.map(category => <button className="btn btn-secondary" type="button" key={category} onClick={() => addLine("import", category)}>Add {category === "Liquid" ? "Tanker" : category}</button>)}</div>}
        <div className="entry-shared-reference"><FormField label="Vessel declaration reference" hint="Used for every included cargo row unless you enter a different reference on that row."><input aria-label="Vessel declaration reference" value={declarationReference} placeholder="Manifest / bill of lading reference" onChange={event => setDeclarationReference(event.target.value)} /></FormField></div>
        <div className="entry-sheet-summary" role="status"><span>{includedRows.length} cargo {includedRows.length === 1 ? "row" : "rows"} included</span><span>{[...new Set(lines.map(line => UNIT_LABELS[line.unit]))].join(" · ") || "Select applicable rows below"}</span></div>
        {["import", "export"].map(direction => <div className="entry-direction" key={direction}>
          <div className="entry-direction-heading"><h3><Icon name={direction === "import" ? "download" : "send"} size={17} />{direction === "import" ? "Import / discharge" : "Export / loading"}</h3><button type="button" className="link-btn" onClick={() => addLine(direction)}>Add {direction} row</button></div>
          {rows.some(row => row.line.direction === direction) ? <div className="entry-sheet-scroll"><table className={`entry-cargo-table${cargoType === "Containers" ? " entry-container-table" : ""}`}><caption className="entry-sr-only">{direction === "import" ? "Import" : "Export"} owner baseline declaration sheet</caption><thead><tr><th scope="col">Use</th>{cargoType === "Containers" ? <th scope="col" colSpan={2}>Container size / load status</th> : <><th scope="col">Cargo / quantity basis</th><th scope="col">Category / direction</th></>}<th scope="col">Unit</th><th scope="col">Manifest quantity</th><th scope="col">Manifest reference</th><th scope="col"><span className="entry-sr-only">Remove</span></th></tr></thead><tbody>
            {rows.map((row, index) => {
              if (row.line.direction !== direction) return null;
              const line = row.line;
              const number = index + 1;
              const knownQuantity = line.manifestQuantity !== null;
              const categoryLabel = line.category === "Liquid" ? "Tanker / liquid cargo" : line.category;
              const containerIdentity = line.category === "Container" && line.containerSize && line.loadStatus
                ? `${line.containerSize} ft · ${line.loadStatus === "laden" ? "Laden" : "Empty"}` : null;
              const compactContainer = cargoType === "Containers" && containerIdentity !== null;
              const includeCell = <td className="entry-include-cell"><label><input type="checkbox" checked={row.included} aria-label={`Include cargo line ${number} · ${line.description || categoryLabel} · ${direction}`} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, included: event.target.checked, edited: true } : item))} /><span className="entry-row-number">{number}</span></label></td>;
              const removeCell = <td><button type="button" className="icon-btn" aria-label={`Remove cargo line ${number}`} onClick={() => setRows(current => current.filter(item => item.id !== row.id))}><Icon name="trash" size={16} /></button></td>;
              if (!row.included) return <tr key={row.id} className="entry-row-excluded">
                {includeCell}
                <td colSpan={2} className="entry-cargo-cell entry-excluded-label"><strong>{containerIdentity || line.description || categoryLabel}</strong><small>{containerIdentity ? line.description : categoryLabel}<span className="entry-excluded-mobile-unit"> · {UNIT_LABELS[line.unit]} · Not included</span></small></td>
                <td className="entry-excluded-unit">{UNIT_LABELS[line.unit]}</td>
                <td colSpan={2} className="entry-excluded-state">Not included{knownQuantity && <small>Entered declaration retained</small>}</td>
                {removeCell}
              </tr>;
              const descriptionField = <FormField label={`Cargo description ${number}`}><input required value={line.description} placeholder={line.category === "Liquid" ? "Product, e.g. petroleum, chemicals or gas" : line.category === "Vehicle" ? "Vehicle type" : "Commodity / parcel"} onChange={event => updateRow(row.id, { description: event.target.value })} /></FormField>;
              const basisField = <FormField label={`Quantity basis ${number}`}><input required value={line.basis} onChange={event => updateRow(row.id, { basis: event.target.value })} /></FormField>;
              const containerFields = line.category === "Container" && <div className="entry-container-context"><FormField label={`Container size ${number}`}><select required value={line.containerSize} onChange={event => updateRow(row.id, { containerSize: event.target.value })}><option value="">Size</option>{["20", "40", "45"].map(size => <option value={size} key={size}>{size} ft</option>)}</select></FormField><FormField label={`Load status ${number}`}><select required value={line.loadStatus} onChange={event => updateRow(row.id, { loadStatus: event.target.value })}><option value="">Loading state</option><option value="laden">Laden</option><option value="empty">Empty</option></select></FormField></div>;
              const categoryFields = <><FormField label={`Category ${number}`}><select disabled={knownQuantity} value={line.category} onChange={event => setCategory(row, event.target.value)}>{CARGO_CATEGORIES.map(category => <option value={category} key={category}>{category === "Liquid" ? "Tanker / liquid cargo" : category}</option>)}</select></FormField><FormField label={`Direction ${number}`}><select value={line.direction} onChange={event => updateRow(row.id, { direction: event.target.value })}><option value="import">Import / discharge</option><option value="export">Export / loading</option></select></FormField></>;
              return <tr key={row.id} className={compactContainer ? "entry-container-preset" : ""}>
                {includeCell}
                {compactContainer ? <td colSpan={2} className="entry-cargo-cell"><strong className="entry-preset-title">{containerIdentity}</strong><details className="entry-cargo-details"><summary aria-label={`Cargo details for line ${number}`}>Cargo details</summary><div>{descriptionField}{containerFields}{basisField}{categoryFields}</div></details></td> : <><td className="entry-cargo-cell">{descriptionField}{line.category === "Liquid" && <small className="entry-product-label">Tanker cargo / product</small>}{containerFields}{basisField}</td><td>{categoryFields}</td></>}
                <td><FormField label={`Unit ${number}`}><select disabled={knownQuantity || unitsFor(line.category).length === 1} value={line.unit} onChange={event => changeUnit(row, event.target.value as QuantityUnit)}>{unitsFor(line.category).map(unit => <option value={unit} key={unit}>{UNIT_LABELS[unit]}</option>)}</select></FormField>{knownQuantity && !compactContainer && <small className="entry-unit-note">Clear the quantity to change its category or unit.</small>}</td>
                <td><FormField label={`Manifest quantity ${number}`}><input type="number" min="0" step={line.unit === "count" ? "1" : "0.001"} value={line.manifestQuantity ?? ""} placeholder="Unknown" onChange={event => updateRow(row.id, { manifestQuantity: event.target.value === "" ? null : event.target.value })} /></FormField><small className={`entry-declaration-state${knownQuantity && Number(line.manifestQuantity) === 0 ? " nil" : ""}`}>{!knownQuantity ? "Unknown" : Number(line.manifestQuantity) === 0 ? "NIL declared" : UNIT_LABELS[line.unit]}</small></td>
                <td className="entry-reference-cell"><FormField label={`Manifest / baseline reference ${number}`}><input required={knownQuantity && !sharedReference} value={line.baselineReference} placeholder={sharedReference ? `Using ${sharedReference}` : knownQuantity ? "Required for declaration" : "Optional until known"} onChange={event => updateRow(row.id, { baselineReference: event.target.value })} /></FormField></td>
                {removeCell}
              </tr>;
            })}
          </tbody></table></div> : <p className="entry-empty-direction">No {direction} rows. Add one if this operation is in scope.</p>}
        </div>)}
        <button className="btn btn-secondary" type="button" onClick={() => addLine()}><Icon name="plus" size={16} />Add cargo line</button>
      </section>

      <section className="entry-section" aria-labelledby="entry-agency-heading">
        <div className="entry-section-title"><span>03</span><div><h2 id="entry-agency-heading">Participating agencies</h2><p>Name the agencies that will measure independently. After setup, record each agency’s readings and source documents separately. Every included cargo row needs a reading or an explained N/A.</p></div></div>
        <div className="entry-agency-presets"><span>Add a participant</span>{AGENCY_ROLES.map(role => <button className="btn btn-secondary" type="button" key={role.value} onClick={() => addParty(role.value)}><Icon name="plus" size={14} />{role.label}</button>)}</div>
        <div className="entry-agency-rows">{parties.map((row, index) => <div className="entry-agency-row" key={row.id}><span className="entry-agency-number">{index + 1}</span><FormField label={`Party name ${index + 1}`}><input required value={row.party.name} placeholder="Agency / company / vessel" onChange={event => updateParty(row.id, { name: event.target.value })} /></FormField><div><FormField label={`Role ${index + 1}`}><select value={row.customRole ? "custom" : row.party.role} onChange={event => setParties(current => current.map(item => item.id === row.id ? { ...item, customRole: event.target.value === "custom", party: { ...item.party, role: event.target.value === "custom" ? "" : event.target.value } } : item))}>{AGENCY_ROLES.map(role => <option value={role.value} key={role.value}>{role.label}</option>)}<option value="custom">Custom role</option></select></FormField>{row.customRole && <FormField label={`Custom role ${index + 1}`}><input required value={row.party.role} onChange={event => updateParty(row.id, { role: event.target.value })} /></FormField>}</div><FormField label={`Representative ${index + 1}`}><input required value={row.party.representative} placeholder="Named representative" onChange={event => updateParty(row.id, { representative: event.target.value })} /></FormField><div className="measurement-checkbox-stack"><label className="measurement-check"><input type="checkbox" checked={row.party.requiredSubmission} onChange={event => updateParty(row.id, { requiredSubmission: event.target.checked })} />Return required</label><label className="measurement-check"><input type="checkbox" checked={row.party.requiredApproval} onChange={event => updateParty(row.id, { requiredApproval: event.target.checked })} />Agreement required</label></div>{parties.length > 1 && <button type="button" className="icon-btn" aria-label={`Remove stakeholder ${index + 1}`} onClick={() => setParties(current => current.filter(item => item.id !== row.id))}><Icon name="trash" size={16} /></button>}</div>)}</div>
        <button className="btn btn-secondary" type="button" onClick={() => addParty()}><Icon name="plus" size={16} />Add stakeholder</button>
      </section>

      <section className="entry-section" aria-labelledby="entry-schedule-heading">
        <div className="entry-section-title"><span>04</span><div><h2 id="entry-schedule-heading">Arrange independent measurements</h2><p>Arrange the survey window and planned method. After setup, each agency submits its own independent reading; NPA reconciliation follows once those readings are available.</p></div></div>
        <div className="measurement-form-grid"><FormField label="Plan title"><input required value={values.title} onChange={event => changeDetail("title", event.target.value)} /></FormField><FormField label="Terminal / berth"><input required value={values.location} onChange={event => changeDetail("location", event.target.value)} /></FormField>
          <FormField label="Scheduled start" hint="Dates use your local time zone."><input required type="datetime-local" value={values.scheduledAt} onChange={event => changeDetail("scheduledAt", event.target.value)} /></FormField><FormField label="Scheduled end (optional)"><input type="datetime-local" min={values.scheduledAt} value={values.endsAt} onChange={event => changeDetail("endsAt", event.target.value)} /></FormField>
          {([['method', 'Measurement method'], ['stage', 'Operation stage'], ['scope', 'Parcel / cargo scope'], ['leadSurveyor', 'Lead surveyor']] as const).map(([key, label]) => <FormField key={key} label={label}><input required value={values[key]} onChange={event => changeDetail(key, event.target.value)} /></FormField>)}
          <FormField label="Planning notes (optional)"><textarea value={values.notes} onChange={event => changeDetail("notes", event.target.value)} /></FormField></div>
      </section>
    </div>
  </ActionForm>;
}
