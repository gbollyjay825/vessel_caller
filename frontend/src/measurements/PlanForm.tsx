// New voyage setup: choose the voyage, copy the owner's paid declaration
// (containers by size and laden/empty, tanker products, bulk, general cargo,
// vehicles — any mix), then choose the agencies that will report readings.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { VesselCall } from "../types";
import { Icon } from "../components/Icon";
import { ErrorMessage, FormField } from "./shared";
import { dateLabel, localDateTime } from "./helpers";
import { AGENCY_ROLES, UNIT_LABELS, basisFor, defaultMethod, type CargoTemplateType } from "./cargoTemplates";
import { groupVesselCalls } from "./voyages";
import { PaidDeclarationFields, emptyPaidDeclaration, validAmount } from "./PaidDeclarationFields";
import type { PaidDeclarationInput } from "./closeoutPreview";
import type { AgencyProfile } from "./agencyDirectory";
import type { CargoLineInput, ParticipantInput, PlanInput, QuantityUnit } from "./types";
import "../styles/measurement-entry.css";

export type CargoKind = "containers" | "tanker" | "bulk" | "general" | "vehicles";
const KINDS: { key: CargoKind; label: string; hint: string; icon: string; template: CargoTemplateType }[] = [
  { key: "containers", label: "Containers", hint: "size · laden or empty", icon: "package", template: "Containers" },
  { key: "tanker", label: "Tanker / liquid", hint: "by product", icon: "droplet", template: "Tanker" },
  { key: "bulk", label: "Dry bulk", hint: "by commodity", icon: "gauge", template: "Bulk" },
  { key: "general", label: "General cargo", hint: "by item", icon: "clipboard", template: "General cargo" },
  { key: "vehicles", label: "Vehicles", hint: "by type", icon: "route", template: "Vehicles" },
];
export const TANKER_PRODUCTS = ["PMS — Premium Motor Spirit", "AGO — Automotive Gas Oil", "DPK — Dual Purpose Kerosene", "ATK — Aviation Turbine Kerosene", "LPG — Liquefied Petroleum Gas", "Crude oil"];
const VEHICLE_TYPES = ["Cars", "Buses", "Trucks", "Mafi trailer / HDV", "Motorcycles", "Other vehicles"];
const OTHER = "__other";

type ItemRow = { id: number; product: string; description: string; quantity: string; unit: QuantityUnit };
type Details = { location: string; leadSurveyor: string; scheduledAt: string; endsAt: string; notes: string };
type PlanFormProps = {
  calls: VesselCall[];
  callId?: string;
  agencyCatalog?: AgencyProfile[];
  canRegisterVessel?: boolean;
  canManageAgencies?: boolean;
  onCreateAgency?: (input: Pick<AgencyProfile, "name" | "role" | "representative">) => Promise<AgencyProfile>;
  paid?: PaidDeclarationInput;
  suggestedAgencyIds?: string[];
  existingSheets?: number;
  onVoyageChange?: (callId: string) => void;
  onSave: (value: PlanInput, paid: PaidDeclarationInput) => Promise<unknown>;
  onCancel: () => void;
};

const blankRow = (id: number, unit: QuantityUnit = "tonnes"): ItemRow => ({ id, product: "", description: "", quantity: "", unit });
const filled = (value: string) => value.trim() !== "";
const validQuantity = (value: string, unit: QuantityUnit) => unit === "count" ? /^\d{1,15}$/.test(value.trim()) : /^\d{1,15}(?:\.\d{1,3})?$/.test(value.trim());
function kindsForCall(call?: VesselCall): CargoKind[] {
  const type = call?.type?.toLowerCase() ?? "";
  if (type.includes("tanker")) return ["tanker"];
  if (type.includes("container")) return ["containers"];
  if (type.includes("bulk")) return ["bulk"];
  // "car" only as a word: a "General cargo" vessel is not a car carrier.
  if (type.includes("ro-ro") || type.includes("vehicle") || /\bcars?\b/.test(type)) return ["vehicles"];
  if (type.includes("general") || type.includes("cargo")) return ["general"];
  return ["containers"];
}

export function PlanForm({ calls, callId: fixedCallId, agencyCatalog = [], canRegisterVessel = false, canManageAgencies = false, onCreateAgency, paid: initialPaid, suggestedAgencyIds = [], existingSheets = 0, onVoyageChange, onSave, onCancel }: PlanFormProps) {
  const vessels = groupVesselCalls(calls.filter(call => call.status !== "cancelled"));
  const fixed = Boolean(fixedCallId);
  const [voyage, setVoyage] = useState(() => ({ vesselKey: vessels.find(vessel => vessel.calls.some(call => call.id === fixedCallId))?.key ?? "", callId: fixedCallId ?? "" }));
  const selectedVessel = vessels.find(vessel => vessel.key === voyage.vesselKey);
  const selectedCall = calls.find(call => call.id === voyage.callId);
  const steps = fixed ? ["Declaration", "Agencies"] : ["Vessel & voyage", "Declaration", "Agencies"];
  const [step, setStep] = useState(0);
  const stepName = steps[step];
  const [details, setDetails] = useState<Details>(() => ({ location: selectedCall?.berth ?? "", leadSurveyor: "To be assigned", scheduledAt: localDateTime(), endsAt: "", notes: "" }));
  const [reference, setReference] = useState("");
  const [kinds, setKinds] = useState<CargoKind[]>(() => kindsForCall(selectedCall));
  const [sizes, setSizes] = useState(["20", "40", "45"]);
  const [newSize, setNewSize] = useState("");
  const [grid, setGrid] = useState<Record<string, { laden: string; empty: string }>>({});
  const nextId = useRef(4);
  const [tanker, setTanker] = useState<ItemRow[]>([blankRow(1)]);
  const [bulk, setBulk] = useState<ItemRow[]>([blankRow(2)]);
  const [general, setGeneral] = useState<ItemRow[]>([blankRow(3)]);
  const [vehicles, setVehicles] = useState<Record<string, string>>({});
  const [paid, setPaid] = useState<PaidDeclarationInput>(() => initialPaid ?? emptyPaidDeclaration());
  const [voyageNotice, setVoyageNotice] = useState<string | null>(null);
  const [selectedAgencyIds, setSelectedAgencyIds] = useState<string[]>([]);
  const [agencyDrafts, setAgencyDrafts] = useState<Record<string, ParticipantInput>>({});
  const [creatingAgency, setCreatingAgency] = useState(false);
  const [agencyPending, setAgencyPending] = useState(false);
  const [agencyError, setAgencyError] = useState<unknown>(null);
  const [newAgency, setNewAgency] = useState({ name: "", role: "Agent", representative: "" });
  const [customRole, setCustomRole] = useState(false);
  const [createdAgencies, setCreatedAgencies] = useState<AgencyProfile[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showProblems, setShowProblems] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [suggestionsApplied, setSuggestionsApplied] = useState(false);
  useEffect(() => { heading.current?.focus(); }, [step]);
  const catalog = [...agencyCatalog, ...createdAgencies.filter(agency => !agencyCatalog.some(profile => profile.id === agency.id))];
  const active = catalog.filter(agency => agency.active);
  const draftFor = (agency: AgencyProfile): ParticipantInput => ({ agencyId: agency.id, name: agency.name, role: agency.role, representative: agency.representative, requiredSubmission: true, requiredApproval: true });
  // Agencies that reported this vessel's last voyage are pre-selected the first time the step opens.
  const applySuggestions = () => {
    if (suggestionsApplied || selectedAgencyIds.length) return;
    const suggested = suggestedAgencyIds.map(id => active.find(agency => agency.id === id)).filter((agency): agency is AgencyProfile => Boolean(agency));
    if (!suggested.length) return;
    setSuggestionsApplied(true);
    setSelectedAgencyIds(suggested.map(agency => agency.id));
    setAgencyDrafts(current => ({ ...Object.fromEntries(suggested.map(agency => [agency.id, draftFor(agency)])), ...current }));
  };

  const changeVoyage = (next: { vesselKey: string; callId: string }) => {
    if (next.callId === voyage.callId && next.vesselKey === voyage.vesselKey) return;
    const call = calls.find(item => item.id === next.callId);
    const hadValues = Object.values(grid).some(row => filled(row.laden) || filled(row.empty)) || [...tanker, ...bulk, ...general].some(row => filled(row.quantity)) || Object.values(vehicles).some(filled) || filled(reference);
    setVoyage(next);
    if (next.callId !== voyage.callId) {
      setGrid({}); setTanker([blankRow(nextId.current++)]); setBulk([blankRow(nextId.current++)]); setGeneral([blankRow(nextId.current++)]); setVehicles({}); setReference("");
      setKinds(kindsForCall(call)); setDetails(current => ({ ...current, location: call?.berth ?? "" })); setPaid(emptyPaidDeclaration());
      setVoyageNotice(hadValues ? "You changed voyage, so the declaration was cleared. Each voyage keeps its own declaration." : null);
      if (next.callId) onVoyageChange?.(next.callId);
    }
  };
  const toggleKind = (kind: CargoKind) => setKinds(current => current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind]);
  const setCell = (size: string, load: "laden" | "empty", value: string) => setGrid(current => ({ ...current, [size]: { laden: current[size]?.laden ?? "", empty: current[size]?.empty ?? "", [load]: value } }));
  const updateRows = (setter: typeof setTanker, id: number, patch: Partial<ItemRow>) => setter(current => current.map(row => row.id === id ? { ...row, ...patch } : row));

  // Blank means not declared; 0 means declared NIL. Units are never converted.
  const lines: CargoLineInput[] = [];
  const problems: string[] = [];
  const add = (category: string, description: string, unit: QuantityUnit, quantity: string, extra: Partial<CargoLineInput> = {}) => {
    if (!validQuantity(quantity, unit)) problems.push(`${description}: enter ${unit === "count" ? "a whole number" : "a number with up to three decimals"}.`);
    lines.push({ description, category, direction: "import", containerSize: "", loadStatus: "", unit, basis: basisFor(category, unit), manifestQuantity: quantity.trim(), baselineReference: reference.trim(), ...extra });
  };
  if (kinds.includes("containers")) for (const size of sizes) for (const load of ["laden", "empty"] as const) {
    const value = grid[size]?.[load] ?? "";
    if (filled(value)) add("Container", `${size} ft ${load} containers`, "count", value, { containerSize: size, loadStatus: load });
  }
  const itemRows = (kind: CargoKind, rows: ItemRow[], category: string, noun: string) => {
    if (!kinds.includes(kind)) return;
    for (const row of rows) {
      const description = (row.product && row.product !== OTHER ? row.product : row.description).trim();
      if (!filled(row.quantity) && !description) continue;
      if (!description) problems.push(`Name the ${noun} declared as ${row.quantity}.`);
      else if (!filled(row.quantity)) problems.push(`${description}: enter the declared quantity or remove the row.`);
      else add(category, description, row.unit, row.quantity);
    }
  };
  itemRows("tanker", tanker, "Liquid", "product");
  itemRows("bulk", bulk, "Bulk", "commodity");
  itemRows("general", general, "General cargo", "item");
  if (kinds.includes("vehicles")) for (const type of VEHICLE_TYPES) if (filled(vehicles[type] ?? "")) add("Vehicle", type, "count", vehicles[type]);
  if (!kinds.length) problems.push("Choose at least one cargo type.");
  else if (!lines.length) problems.push("Enter at least one declared quantity.");
  if (lines.length && !filled(reference)) problems.push("Enter the manifest or bill of lading reference.");
  if (!validAmount(paid.amountPaid)) problems.push("Enter the amount paid as a number.");
  const totals = new Map<string, number>();
  for (const line of lines) if (validQuantity(line.manifestQuantity ?? "", line.unit)) {
    const key = line.category === "Container" ? "containers" : line.category === "Vehicle" ? "vehicles" : line.unit === "count" ? "items" : line.unit === "m3" ? "m³" : "t";
    totals.set(key, (totals.get(key) ?? 0) + Number(line.manifestQuantity));
  }
  const totalLabel = [...totals].map(([unit, total]) => `${total.toLocaleString()} ${unit}`).join(" · ");
  const participants = selectedAgencyIds.map(id => agencyDrafts[id]).filter(Boolean);
  const primary = kinds.length === 1 ? KINDS.find(item => item.key === kinds[0])! : null;
  const title = `${primary ? primary.template : "Mixed cargo"} discharge tally${selectedCall ? ` · ${selectedCall.vesselName} · ${selectedCall.reference}` : ""}`;

  const blocked = pending || creatingAgency || (stepName === "Vessel & voyage" && !selectedCall) || (stepName === "Declaration" && problems.length > 0) || (stepName === "Agencies" && !participants.length);
  const createAgency = async () => {
    if (!onCreateAgency || agencyPending || !newAgency.name.trim() || !newAgency.role.trim()) return;
    setAgencyPending(true); setAgencyError(null);
    try {
      const agency = await onCreateAgency({ name: newAgency.name.trim(), role: newAgency.role.trim(), representative: newAgency.representative.trim() });
      setCreatedAgencies(current => [...current.filter(profile => profile.id !== agency.id), agency]);
      setAgencyDrafts(current => ({ ...current, [agency.id]: draftFor(agency) }));
      setSelectedAgencyIds(current => current.includes(agency.id) ? current : [...current, agency.id]);
      setCreatingAgency(false); setNewAgency({ name: "", role: "Agent", representative: "" }); setCustomRole(false);
    } catch (failure) { setAgencyError(failure); }
    finally { setAgencyPending(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (stepName === "Declaration" && problems.length) { setShowProblems(true); return; }
    if (blocked) return;
    setError(null);
    if (step < steps.length - 1) {
      if (steps[step + 1] === "Agencies") applySuggestions();
      setStep(current => current + 1);
      return;
    }
    if (!selectedCall) return;
    setPending(true);
    try {
      await onSave({
        callId: selectedCall.id, title, method: defaultMethod(primary?.template ?? "Mixed"), stage: "Discharge",
        scope: lines.map(line => line.description).join("; "), location: details.location.trim(), leadSurveyor: details.leadSurveyor.trim() || "To be assigned",
        scheduledAt: new Date(details.scheduledAt).toISOString(), endsAt: details.endsAt ? new Date(details.endsAt).toISOString() : null, notes: details.notes,
        lines, participants,
      }, { ...paid, amountPaid: paid.amountPaid.replaceAll(",", "") });
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  };
  const itemTable = (kind: CargoKind, rows: ItemRow[], setter: typeof setTanker, noun: string, units: QuantityUnit[], products?: string[]) => <div className="entry-items">
    <div className="entry-items-scroll"><table className="entry-items-table"><caption className="hide-sr">{KINDS.find(item => item.key === kind)?.label} declared</caption>
      <thead><tr><th scope="col">{noun[0].toUpperCase() + noun.slice(1)}</th><th scope="col">Declared quantity</th><th scope="col">Unit</th><th scope="col"><span className="hide-sr">Remove</span></th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id}>
        <td>{products ? <div className="entry-product">
          <label className="hide-sr" htmlFor={`product-${row.id}`}>{`${noun} ${index + 1}`}</label>
          <select id={`product-${row.id}`} value={row.product} onChange={event => updateRows(setter, row.id, { product: event.target.value })}><option value="">Choose product</option>{products.map(product => <option key={product}>{product}</option>)}<option value={OTHER}>Other product…</option></select>
          {row.product === OTHER && <><label className="hide-sr" htmlFor={`product-other-${row.id}`}>Other product {index + 1}</label><input id={`product-other-${row.id}`} value={row.description} placeholder="Product name" onChange={event => updateRows(setter, row.id, { description: event.target.value })} /></>}
        </div> : <><label className="hide-sr" htmlFor={`item-${row.id}`}>{`${noun} ${index + 1}`}</label><input id={`item-${row.id}`} value={row.description} placeholder={kind === "bulk" ? "e.g. wheat, clinker, fertiliser" : "e.g. steel coils, bagged rice"} onChange={event => updateRows(setter, row.id, { description: event.target.value })} /></>}</td>
        <td><label className="hide-sr" htmlFor={`qty-${row.id}`}>{`Declared quantity ${noun} ${index + 1}`}</label><input id={`qty-${row.id}`} className="entry-number" inputMode="decimal" value={row.quantity} placeholder="Not declared" onChange={event => updateRows(setter, row.id, { quantity: event.target.value })} /></td>
        <td><label className="hide-sr" htmlFor={`unit-${row.id}`}>{`Unit ${noun} ${index + 1}`}</label><select id={`unit-${row.id}`} value={row.unit} disabled={units.length === 1} onChange={event => updateRows(setter, row.id, { unit: event.target.value as QuantityUnit })}>{units.map(unit => <option key={unit} value={unit}>{UNIT_LABELS[unit]}</option>)}</select></td>
        <td><button type="button" className="icon-btn" aria-label={`Remove ${noun} ${index + 1}`} disabled={rows.length === 1} onClick={() => setter(current => current.filter(item => item.id !== row.id))}><Icon name="trash" size={16} /></button></td>
      </tr>)}</tbody>
    </table></div>
    <button type="button" className="link-btn entry-add" onClick={() => setter(current => [...current, blankRow(nextId.current++, units[0])])}><Icon name="plus" size={14} /> Add {noun}</button>
  </div>;

  return <form className="entry-form" noValidate onSubmit={event => void submit(event)}>
    <ol className="entry-steps" aria-label="Voyage setup steps">{steps.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "complete" : ""} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Icon name="check" size={13} strokeWidth={3} /> : index + 1}</span>{label}</li>)}</ol>
    <fieldset disabled={pending} className="entry-fieldset">
      <h2 ref={heading} tabIndex={-1} className="entry-heading">{stepName === "Vessel & voyage" ? "Which voyage is this?" : stepName === "Declaration" ? "What the vessel owner declared and paid for" : "Which agencies will report readings?"}</h2>

      {stepName === "Vessel & voyage" && <div className="entry-section">
        <p className="entry-help">The same vessel can have many voyages. Each voyage keeps its own declaration.</p>
        <div className="entry-grid-2">
          <FormField label="Vessel"><select required value={voyage.vesselKey} onChange={event => { const vessel = vessels.find(item => item.key === event.target.value); changeVoyage({ vesselKey: event.target.value, callId: vessel?.calls.length === 1 ? vessel.calls[0].id : "" }); }}><option value="">Select a vessel</option>{vessels.map(vessel => <option value={vessel.key} key={vessel.key}>{vessel.name}{vessel.flag ? ` · ${vessel.flag}` : ""}</option>)}</select></FormField>
          <FormField label="Voyage"><select required disabled={!selectedVessel} value={voyage.callId} onChange={event => changeVoyage({ ...voyage, callId: event.target.value })}><option value="">Select a voyage</option>{selectedVessel?.calls.map(call => <option value={call.id} key={call.id}>{call.reference}{call.eta ? ` · ETA ${dateLabel(call.eta)}` : ""}</option>)}</select></FormField>
        </div>
        {canRegisterVessel && <p className="entry-help"><a className="link-btn" href="/app/vessel-calls?register">Register a new vessel voyage</a></p>}
        {voyageNotice && <p className="measurement-notice warning" role="status">{voyageNotice}</p>}
        {selectedCall ? <dl className="entry-voyage-facts">{[["Vessel type", selectedCall.type], ["Flag", selectedCall.flag], ["Net tonnage", selectedCall.nrt == null ? "" : selectedCall.nrt.toLocaleString()], ["ETA", selectedCall.eta ? dateLabel(selectedCall.eta) : ""], ["Berth", selectedCall.berth]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not recorded"}</dd></div>)}</dl>
          : <p className="entry-empty">{vessels.length ? "Choose the vessel and voyage you are preparing." : "No active voyages yet. Register the vessel voyage first."}</p>}
        {selectedCall && <details className="entry-more"><summary>Measurement details (optional)</summary><div className="entry-grid-2">
          <FormField label="Terminal / berth"><input value={details.location} placeholder="Not recorded" onChange={event => setDetails(current => ({ ...current, location: event.target.value }))} /></FormField>
          <FormField label="Lead surveyor"><input value={details.leadSurveyor} onChange={event => setDetails(current => ({ ...current, leadSurveyor: event.target.value }))} /></FormField>
          <FormField label="Measurement starts" hint="Your local time."><input type="datetime-local" value={details.scheduledAt} onChange={event => setDetails(current => ({ ...current, scheduledAt: event.target.value }))} /></FormField>
          <FormField label="Measurement ends (optional)"><input type="datetime-local" min={details.scheduledAt} value={details.endsAt} onChange={event => setDetails(current => ({ ...current, endsAt: event.target.value }))} /></FormField>
        </div></details>}
      </div>}

      {stepName === "Declaration" && <div className="entry-declaration">
        <div className="entry-section entry-cargo">
          {existingSheets > 0 && <p className="measurement-notice warning">This voyage already has a declaration. Continue only to add a separate cargo sheet.</p>}
          <p className="entry-help">Copy the owner’s declaration exactly. <strong>Blank = not declared · 0 = declared NIL.</strong> Counts, tonnes and m³ stay separate — nothing is converted.</p>
          <FormField label="Manifest / bill of lading reference"><input value={reference} onChange={event => setReference(event.target.value)} placeholder="e.g. MAN-AP-0412" /></FormField>
          <fieldset className="entry-kinds"><legend>Cargo on board <span>— choose every type; mixed cargo simply has more than one</span></legend>
            <div>{KINDS.map(kind => <button type="button" key={kind.key} className={kinds.includes(kind.key) ? "on" : ""} aria-pressed={kinds.includes(kind.key)} onClick={() => toggleKind(kind.key)}><Icon name={kinds.includes(kind.key) ? "check" : kind.icon} size={17} strokeWidth={kinds.includes(kind.key) ? 2.6 : 1.75} /><span>{kind.label}<small>{kind.hint}</small></span></button>)}</div>
          </fieldset>
          {kinds.length > 1 && <p className="entry-mixed">Mixed cargo · {kinds.length} types on this voyage</p>}

          {kinds.includes("containers") && <section className="entry-block" aria-labelledby="containers-heading">
            <h3 id="containers-heading">Containers <span>· count by size and load</span></h3>
            <div className="entry-items-scroll"><table className="entry-matrix"><caption className="hide-sr">Declared containers by size, laden and empty</caption>
              <thead><tr><th scope="col">Size</th><th scope="col">Laden</th><th scope="col">Empty</th><th scope="col">Total</th></tr></thead>
              <tbody>{sizes.map(size => {
                const row = grid[size] ?? { laden: "", empty: "" };
                const total = [row.laden, row.empty].filter(value => validQuantity(value, "count")).reduce((sum, value) => sum + Number(value), 0);
                return <tr key={size}><th scope="row">{size} ft</th>
                  {(["laden", "empty"] as const).map(load => <td key={load}><label className="hide-sr" htmlFor={`c-${size}-${load}`}>{size} ft {load} declared</label><input id={`c-${size}-${load}`} className="entry-number" inputMode="numeric" value={row[load]} placeholder="—" onChange={event => setCell(size, load, event.target.value)} /></td>)}
                  <td className="entry-total">{filled(row.laden) || filled(row.empty) ? total.toLocaleString() : "—"}</td></tr>;
              })}</tbody>
            </table></div>
            <div className="entry-add-size"><label className="hide-sr" htmlFor="new-size">Another container size in feet</label><input id="new-size" inputMode="numeric" value={newSize} placeholder="Size, e.g. 53" onChange={event => setNewSize(event.target.value.replace(/\D/g, "").slice(0, 3))} /><button type="button" className="link-btn" disabled={!newSize || sizes.includes(newSize)} onClick={() => { setSizes(current => [...current, newSize]); setNewSize(""); }}><Icon name="plus" size={14} /> Add size</button></div>
          </section>}
          {kinds.includes("tanker") && <section className="entry-block" aria-labelledby="tanker-heading"><h3 id="tanker-heading">Tanker / liquid <span>· by product</span></h3>{itemTable("tanker", tanker, setTanker, "product", ["tonnes", "m3"], TANKER_PRODUCTS)}</section>}
          {kinds.includes("bulk") && <section className="entry-block" aria-labelledby="bulk-heading"><h3 id="bulk-heading">Dry bulk <span>· by commodity</span></h3>{itemTable("bulk", bulk, setBulk, "commodity", ["tonnes", "m3"])}</section>}
          {kinds.includes("general") && <section className="entry-block" aria-labelledby="general-heading"><h3 id="general-heading">General cargo <span>· by item</span></h3>{itemTable("general", general, setGeneral, "item", ["tonnes", "count", "m3"])}</section>}
          {kinds.includes("vehicles") && <section className="entry-block" aria-labelledby="vehicles-heading"><h3 id="vehicles-heading">Vehicles <span>· count by type</span></h3><div className="entry-vehicles">{VEHICLE_TYPES.map(type => <label key={type} className="measurement-field"><span>{type}</span><input className="entry-number" inputMode="numeric" value={vehicles[type] ?? ""} placeholder="—" onChange={event => setVehicles(current => ({ ...current, [type]: event.target.value }))} /></label>)}</div></section>}
          <p className="entry-totals" aria-live="polite">{totalLabel ? `Declared: ${totalLabel}` : "Nothing declared yet."}</p>
          {showProblems && problems.length > 0 && <div className="measurement-notice warning" role="alert"><strong>Before you continue</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
        </div>
        <aside className="entry-section entry-paid" aria-labelledby="entry-paid-heading">
          <h3 id="entry-paid-heading"><Icon name="receipt" size={16} /> Paid declaration</h3>
          <p className="entry-help">The variation invoice charges only cargo above this declaration.</p>
          <PaidDeclarationFields value={paid} onChange={setPaid} idPrefix="entry-paid" />
        </aside>
      </div>}

      {stepName === "Agencies" && <div className="entry-section">
        <p className="entry-help">Each agency records its own reading — by secure link, or entered by your staff from a paper tally. You can invite them on the next screen.{suggestionsApplied && " Agencies from this vessel’s last voyage are pre-selected."}</p>
        <div className="entry-agency-toolbar">{canManageAgencies && onCreateAgency && <button type="button" className="btn btn-secondary btn-sm" disabled={creatingAgency} onClick={() => { setCreatingAgency(true); setAgencyError(null); }}><Icon name="plus" size={14} /> New agency</button>}</div>
        {creatingAgency && <div className="entry-new-agency" role="group" aria-labelledby="new-agency-heading"><h3 id="new-agency-heading">New agency</h3><fieldset disabled={agencyPending}><div className="entry-grid-2">
          <FormField label="Agency name"><input value={newAgency.name} onChange={event => setNewAgency(current => ({ ...current, name: event.target.value }))} /></FormField>
          <FormField label="Agency role"><select value={customRole ? "custom" : newAgency.role} onChange={event => { const custom = event.target.value === "custom"; setCustomRole(custom); setNewAgency(current => ({ ...current, role: custom ? "" : event.target.value })); }}>{AGENCY_ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}<option value="custom">Other role</option></select></FormField>
          {customRole && <FormField label="Other agency role"><input value={newAgency.role} onChange={event => setNewAgency(current => ({ ...current, role: event.target.value }))} /></FormField>}
          <FormField label="Default representative (optional)"><input value={newAgency.representative} onChange={event => setNewAgency(current => ({ ...current, representative: event.target.value }))} /></FormField>
        </div></fieldset><ErrorMessage error={agencyError} /><div className="measurement-inline-actions"><button type="button" className="btn btn-secondary" disabled={agencyPending} onClick={() => { setCreatingAgency(false); setAgencyError(null); }}>Cancel</button><button type="button" className="btn btn-primary" disabled={agencyPending || !newAgency.name.trim() || !newAgency.role.trim()} onClick={() => void createAgency()}>{agencyPending ? "Saving…" : "Save agency"}</button></div></div>}
        {active.length ? <div className="entry-agencies">{active.map(agency => {
          const selected = selectedAgencyIds.includes(agency.id);
          const draft = agencyDrafts[agency.id];
          return <div key={agency.id} className={`entry-agency${selected ? " on" : ""}`} role="group" aria-label={`Agency ${agency.name}`}>
            <label className="entry-agency-choice"><input type="checkbox" checked={selected} aria-label={`Select agency ${agency.name}`} onChange={event => {
              if (event.target.checked) { setAgencyDrafts(current => current[agency.id] ? current : { ...current, [agency.id]: draftFor(agency) }); setSelectedAgencyIds(current => [...current, agency.id]); }
              else setSelectedAgencyIds(current => current.filter(id => id !== agency.id));
            }} /><span><strong>{agency.name}</strong><small>{AGENCY_ROLES.find(role => role.value === agency.role)?.label ?? agency.role}</small></span></label>
            {selected && draft && <label className="measurement-field"><span>Representative for this voyage</span><input aria-label={`Representative for ${agency.name}`} value={draft.representative} onChange={event => setAgencyDrafts(current => ({ ...current, [agency.id]: { ...current[agency.id], representative: event.target.value } }))} /></label>}
          </div>;
        })}</div> : <p className="entry-empty">{canManageAgencies ? "No agencies yet. Create one here or in Agencies." : "No agencies yet. Ask an administrator to add them in Agencies."}</p>}
        <details className="entry-more"><summary>Declaration · {lines.length} cargo {lines.length === 1 ? "line" : "lines"}{totalLabel ? ` · ${totalLabel}` : ""}</summary><ul className="entry-review">{lines.map(line => <li key={`${line.category}:${line.description}`}><span>{line.description}</span><strong>{Number(line.manifestQuantity) === 0 ? "NIL (0)" : line.manifestQuantity} {UNIT_LABELS[line.unit].toLowerCase()}</strong></li>)}</ul><p className="entry-help">Paid declaration: {paid.invoiceReference || "invoice number not recorded"} · {paid.paymentStatus === "paid" ? "payment confirmed" : "payment not yet confirmed"}</p></details>
      </div>}
    </fieldset>
    <ErrorMessage error={error} />
    <div className="entry-actions">
      <button className="link-btn" type="button" disabled={pending} onClick={onCancel}>Cancel</button>
      <div>
        {step > 0 && <button className="btn btn-secondary" type="button" disabled={pending} onClick={() => { setStep(current => current - 1); setError(null); setShowProblems(false); }}>Back</button>}
        <button className="btn btn-primary" type="submit" disabled={blocked && !(stepName === "Declaration" && problems.length > 0)}>{pending ? "Saving…" : step === steps.length - 1 ? "Create voyage and invite agencies" : stepName === "Declaration" ? "Continue to agencies" : "Continue"}{step < steps.length - 1 && <Icon name="arrowRight" size={16} />}</button>
      </div>
    </div>
  </form>;
}
