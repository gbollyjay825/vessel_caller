/* ============================================================
   registerCall.js — Register Vessel Call slide-over (spec §1.6.2).
   Shared by the dashboard empty state and the Vessel Calls list.
   Validation on blur + submit, async reference uniqueness check,
   success toast, unsaved-changes guard. Never loses entered data
   on a failed submit (spec §1.11).
   ============================================================ */
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../store.js";
import { field, button } from "../components/ui.js";
import { openPanel } from "../components/modal.js";
import { toastSuccess, toastError } from "../components/toast.js";
import { toDateTimeLocal } from "../format.js";

const REF_RE = /^ROT-\d{4}-\d{4}$/i;

export function openRegisterCall({ onCreated } = {}) {
  const suggested = api.suggestRef();
  let refOk = true; // suggested ref is known-unique
  let refToken = 0;
  let dirty = false;
  let submitting = false;

  const fName = field({
    label: "Vessel name",
    placeholder: "e.g. MT Sea Phoenix",
    required: true,
    autofocus: true,
  });
  const fRef = field({
    label: "Call reference",
    value: suggested,
    required: true,
    hint: "Format ROT-YYYY-NNNN · must be unique",
  });
  const fType = field({
    kind: "select",
    label: "Vessel type",
    value: "Tanker",
    options: ["Tanker", "Bulk Carrier", "Container", "General Cargo", "Other"],
  });
  const fFlag = field({ label: "Flag / registry", placeholder: "e.g. Liberia" });
  const fNrt = field({
    kind: "number",
    label: "Net registered tonnage",
    placeholder: "e.g. 28000",
    required: true,
    min: 0,
    inputmode: "decimal",
    hint: "Drives the harbour dues calculation",
  });
  const fEta = field({ kind: "datetime-local", label: "ETA", value: toDateTimeLocal() });
  const fBerth = field({ kind: "select", label: "Berth / terminal", options: ["Loading…"] });
  const fNotes = field({
    kind: "textarea",
    label: "Notes (optional)",
    placeholder: "Anything the inspector should know…",
  });

  // Populate berths from settings
  api.getSettings().then((s) => {
    fBerth.input.replaceChildren(
      h("option", { value: "" }, "Select terminal…"),
      ...s.port.terminals.map((tname) => h("option", { value: tname }, tname))
    );
  });

  const allFields = [fName, fRef, fType, fFlag, fNrt, fEta, fBerth, fNotes];
  allFields.forEach((f) => {
    f.input.addEventListener("input", () => (dirty = true));
    f.input.addEventListener("change", () => (dirty = true));
  });

  /* ---- async reference uniqueness ---- */
  function checkRef() {
    const v = fRef.value;
    if (!v) {
      refOk = false;
      fRef.setStatus(null);
      return;
    }
    if (!REF_RE.test(v)) {
      fRef.setStatus("taken", "Use the format ROT-YYYY-NNNN");
      refOk = false;
      return;
    }
    const token = ++refToken;
    refOk = false;
    fRef.clearError();
    fRef.setStatus("checking", "Checking availability…");
    api.checkRefUnique(v).then((ok) => {
      if (token !== refToken) return; // a newer check superseded this one
      refOk = ok;
      fRef.setStatus(ok ? "ok" : "taken", ok ? "Reference available" : "Reference already in use");
    });
  }
  let refDebounce;
  fRef.input.addEventListener("input", () => {
    clearTimeout(refDebounce);
    fRef.setStatus(null);
    refDebounce = setTimeout(checkRef, 450);
  });
  fRef.input.addEventListener("blur", checkRef);
  checkRef();

  /* ---- inline required validation on blur ---- */
  fName.input.addEventListener("blur", () =>
    fName.value ? fName.clearError() : fName.setError("Vessel name is required")
  );
  fNrt.input.addEventListener("blur", () => {
    const n = Number(fNrt.value);
    if (!fNrt.value) fNrt.setError("Tonnage is required");
    else if (!(n > 0)) fNrt.setError("Enter a number greater than 0");
    else fNrt.clearError();
  });

  /* ---- submit ---- */
  const submitIcon = h("span", { style: { display: "inline-flex" } }, icon("check", { size: 16 }));
  const submitBtn = h(
    "button.btn.btn--primary",
    { type: "button", onClick: submit },
    submitIcon,
    h("span", "Register Call")
  );
  const setLoading = (v) => {
    submitBtn.disabled = v;
    submitIcon.replaceChildren(v ? h("span.spinner") : icon("check", { size: 16 }));
  };

  async function submit() {
    let ok = true;
    if (!fName.value) (fName.setError("Vessel name is required"), (ok = false));
    const nrt = Number(fNrt.value);
    if (!fNrt.value) (fNrt.setError("Tonnage is required"), (ok = false));
    else if (!(nrt > 0)) (fNrt.setError("Enter a number greater than 0"), (ok = false));
    if (!fRef.value) (fRef.setError("Reference is required"), (ok = false));
    if (fRef.value && !refOk) {
      fRef.setStatus("taken", "Choose a unique reference");
      ok = false;
    }
    if (!ok) {
      toastError("Check the form", "Some fields need your attention.");
      return;
    }

    submitting = true;
    setLoading(true);
    try {
      const call = await api.createVesselCall({
        vesselName: fName.value,
        ref: fRef.value,
        type: fType.value,
        flag: fFlag.value,
        nrt,
        eta: fEta.input.value,
        berth: fBerth.value,
        notes: fNotes.value,
      });
      dirty = false;
      toastSuccess(`Vessel call ${call.ref} registered`, `${call.vesselName} added to the register.`);
      ctl.close();
      onCreated && onCreated(call);
    } catch (err) {
      submitting = false;
      setLoading(false);
      toastError("Could not register call", err.message);
    }
  }

  const body = h(
    "div",
    fName.el,
    fRef.el,
    h("div.field-row", fType.el, fFlag.el),
    h("div.field-row", fNrt.el, fEta.el),
    fBerth.el,
    fNotes.el
  );

  const ctl = openPanel({
    kind: "slideover",
    title: "Register Vessel Call",
    subtitle: "Log an incoming vessel to begin inspections.",
    isDirty: () => dirty && !submitting,
    body,
    footer: (c) =>
      h(
        "div.panel__foot",
        button({ label: "Cancel", variant: "secondary", onClick: () => c.requestClose() }),
        submitBtn
      ),
  });

  return ctl;
}
