// Variation tariff: the rates applied to cargo carried above a voyage's paid
// declaration. Approved final quantities use them to draft the invoice.
import { useState, type FormEvent } from "react";
import { useBreadcrumbs } from "../app/breadcrumbs";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { dateLabel } from "../measurements/helpers";
import { ErrorMessage } from "../measurements/shared";
import { TARIFF_RATES, useVariationTariff, validRate, type VariationTariffInput } from "../measurements/tariffs";
import "../styles/measurements.css";
import "../styles/voyage-workspace.css";
import "../styles/vessels.css";

const GROUPS = [...new Set(TARIFF_RATES.map(rate => rate.group))];

export function TariffSettings() {
  useBreadcrumbs([{ label: "Variation tariff" }]);
  const { org, user, can } = useAuth();
  const { toast } = useStore();
  const { tariff, error: readError, save } = useVariationTariff(org?.id);
  const canEdit = can("measurements.bill");
  const [input, setInput] = useState<VariationTariffInput>(() => ({ currency: tariff?.currency ?? "USD", reference: tariff?.reference ?? "", rates: { ...(tariff?.rates ?? {}) } }));
  const [error, setError] = useState<unknown>(null);
  const invalid = TARIFF_RATES.filter(rate => (input.rates[rate.key] ?? "").trim() !== "" && !validRate(input.rates[rate.key]));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!user || !canEdit) return;
    setError(null);
    try { save(input, { id: user.id, name: user.name }); toast("Variation tariff saved"); }
    catch (failure) { setError(failure); }
  };
  return <div className="content-inner measurement-workspace tariff-page">
    <div className="page-head"><div><h1>Variation tariff</h1><p className="desc">Rates for cargo carried above a voyage’s paid declaration. When final quantities are approved, the variation invoice is drafted with these rates.</p></div></div>
    <ErrorMessage error={readError ? new Error(readError) : error} />
    <form onSubmit={submit} className="voyage-columns">
      <div className="voyage-main">
        {GROUPS.map(group => <section key={group} className="voyage-card" aria-labelledby={`tariff-${group}`}>
          <div className="voyage-card-head"><h2 id={`tariff-${group}`}>{group}</h2></div>
          <div className="vessels-scroll"><table className="vessels-table tariff-table"><thead><tr><th scope="col">Classification</th><th scope="col">Unit</th><th scope="col">Rate ({input.currency})</th></tr></thead>
            <tbody>{TARIFF_RATES.filter(rate => rate.group === group).map(rate => <tr key={rate.key}>
              <th scope="row">{rate.label}</th><td>{rate.per}</td>
              <td><label className="hide-sr" htmlFor={`rate-${rate.key}`}>{group} {rate.label} rate</label><input id={`rate-${rate.key}`} inputMode="decimal" disabled={!canEdit} value={input.rates[rate.key] ?? ""} placeholder="Not set" aria-invalid={invalid.includes(rate)} onChange={event => setInput(current => ({ ...current, rates: { ...current.rates, [rate.key]: event.target.value } }))} /></td>
            </tr>)}</tbody></table></div>
        </section>)}
      </div>
      <aside className="voyage-aside">
        <section className="voyage-card voyage-card-pad tariff-summary" aria-labelledby="tariff-summary-heading">
          <h2 id="tariff-summary-heading">Tariff</h2>
          <label className="measurement-field"><span>Reference</span><input value={input.reference} disabled={!canEdit} onChange={event => setInput(current => ({ ...current, reference: event.target.value }))} placeholder="e.g. Variation tariff 2026, version 2" /></label>
          <label className="measurement-field"><span>Currency</span><select value={input.currency} disabled={!canEdit} onChange={event => setInput(current => ({ ...current, currency: event.target.value as VariationTariffInput["currency"] }))}><option value="USD">USD — US dollar</option><option value="NGN">NGN — Nigerian naira</option></select></label>
          <p className="tracker-help">Leave a rate blank if it does not apply. A missing rate is asked for on the invoice when it is needed.</p>
          {invalid.length > 0 && <p className="paid-error" role="alert">Use numbers with up to four decimal places.</p>}
          {canEdit ? <button type="submit" className="btn btn-primary" disabled={!input.reference.trim() || invalid.length > 0}>Save tariff</button> : <p className="tracker-help">Read-only. Finance maintains the variation tariff.</p>}
          {tariff && <p className="tracker-help">Last saved by {tariff.updatedBy.name} · {dateLabel(tariff.updatedAt)}</p>}
          <p className="preview-storage-notice"><Icon name="info" size={14} />Rates are kept in this browser until the server tariff table is connected.</p>
        </section>
      </aside>
    </form>
  </div>;
}
