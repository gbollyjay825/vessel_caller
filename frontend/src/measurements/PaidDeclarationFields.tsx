// What the vessel owner has already paid for this voyage's declaration. The
// variation invoice charges only cargo above it, so it is captured up front.
import { useState } from "react";
import { Icon } from "../components/Icon";
import type { PaidDeclaration, PaidDeclarationInput } from "./closeoutPreview";
import { ErrorMessage } from "./shared";

export const emptyPaidDeclaration = (): PaidDeclarationInput => ({ payer: "", agent: "", invoiceReference: "", amountPaid: "", currency: "USD", paidOn: "", paymentStatus: "unconfirmed" });
export const paidDeclarationInput = (value?: PaidDeclaration | PaidDeclarationInput | null): PaidDeclarationInput => value
  ? { payer: value.payer, agent: value.agent, invoiceReference: value.invoiceReference, amountPaid: value.amountPaid, currency: value.currency, paidOn: value.paidOn, paymentStatus: value.paymentStatus }
  : emptyPaidDeclaration();
export const validAmount = (value: string) => value.trim() === "" || /^\d{1,15}(?:\.\d{1,2})?$/.test(value.trim().replaceAll(",", ""));

export function PaidDeclarationFields({ value, onChange, disabled = false, idPrefix = "paid" }: { value: PaidDeclarationInput; onChange: (value: PaidDeclarationInput) => void; disabled?: boolean; idPrefix?: string }) {
  const set = <K extends keyof PaidDeclarationInput>(key: K, next: PaidDeclarationInput[K]) => onChange({ ...value, [key]: next });
  return <fieldset className="paid-fields" disabled={disabled}>
    <label className="measurement-field"><span>Payer (vessel owner)</span><input value={value.payer} onChange={event => set("payer", event.target.value)} placeholder="Name on the declaration invoice" /></label>
    <label className="measurement-field"><span>Paying agent (optional)</span><input value={value.agent} onChange={event => set("agent", event.target.value)} /></label>
    <label className="measurement-field"><span>Declaration invoice number</span><input value={value.invoiceReference} onChange={event => set("invoiceReference", event.target.value)} /></label>
    <div className="paid-fields-row">
      <label className="measurement-field"><span>Amount paid</span><input inputMode="decimal" value={value.amountPaid} aria-invalid={!validAmount(value.amountPaid)} onChange={event => set("amountPaid", event.target.value)} />{!validAmount(value.amountPaid) && <small className="paid-error">Enter a number with up to two decimals.</small>}</label>
      <label className="measurement-field paid-currency"><span>Currency</span><select value={value.currency} onChange={event => set("currency", event.target.value as PaidDeclarationInput["currency"])}><option value="USD">USD</option><option value="NGN">NGN</option></select></label>
    </div>
    <label className="measurement-field"><span>Paid on</span><input type="date" value={value.paidOn} onChange={event => set("paidOn", event.target.value)} /></label>
    <div role="radiogroup" aria-label="Payment status" className="paid-status">
      {([["paid", "Confirmed paid"], ["unconfirmed", "Awaiting confirmation"]] as const).map(([status, label]) => <label key={status} className={value.paymentStatus === status ? "selected" : ""}><input type="radio" name={`${idPrefix}-status`} checked={value.paymentStatus === status} onChange={() => set("paymentStatus", status)} />{label}</label>)}
    </div>
  </fieldset>;
}

/** Stand-alone card for an existing voyage: edit and save the paid declaration. */
export function PaidDeclarationCard({ declaration, canEdit, onSave }: { declaration?: PaidDeclaration; canEdit: boolean; onSave: (value: PaidDeclarationInput) => PaidDeclaration | null }) {
  const [value, setValue] = useState(() => paidDeclarationInput(declaration));
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(paidDeclarationInput(declaration));
  return <section className="voyage-card voyage-card-pad paid-card" aria-labelledby="paid-heading">
    <div className="paid-card-head"><span aria-hidden="true"><Icon name="receipt" size={17} /></span><h2 id="paid-heading">Paid declaration</h2></div>
    <p className="paid-help">The variation invoice charges only cargo above this declaration. It is never charged twice.</p>
    <PaidDeclarationFields value={value} disabled={!canEdit} onChange={next => { setValue(next); setSaved(false); }} idPrefix="paid-card" />
    <ErrorMessage error={error} />
    {saved && !dirty && <p className="paid-saved" role="status"><Icon name="check" size={14} strokeWidth={3} />Saved</p>}
    {canEdit && <button type="button" className="btn btn-primary" disabled={!dirty || !validAmount(value.amountPaid)} onClick={() => {
      setError(null);
      const result = onSave({ ...value, amountPaid: value.amountPaid.replaceAll(",", "") });
      if (result) setSaved(true); else setError(new Error("The paid declaration could not be saved in this browser."));
    }}>Save paid declaration</button>}
    {declaration && <p className="paid-help">Last updated by {declaration.updatedBy.name}.</p>}
  </section>;
}
