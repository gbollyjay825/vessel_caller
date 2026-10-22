import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { ReturnForm } from "./WorkflowForms";
import type { MeasurementPlan, SubmissionInput } from "./types";
import "../styles/agency-reading-dialog.css";

export function AgencyReadingDialog({ plan, participantId, onSave, onClose }: {
  plan: MeasurementPlan;
  participantId: string;
  onSave: (input: SubmissionInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const agency = plan.participants.find(party => party.id === participantId);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="agency-reading-dialog" aria-labelledby="agency-reading-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <div className="agency-reading-dialog-head"><div><h2 id="agency-reading-title">{agency?.name} reading</h2><p>{plan.vesselName} · {plan.callReference}</p></div><button type="button" className="icon-btn" aria-label="Close reading" disabled={pending} onClick={onClose}><Icon name="x" size={20} /></button></div>
    <ReturnForm plan={plan} initialParticipantId={participantId} fixedAgency collectionOnly onCancel={onClose} onSave={async input => {
      setPending(true);
      try { return await onSave(input); }
      finally { setPending(false); }
    }} />
  </dialog>;
}
