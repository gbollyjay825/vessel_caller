import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assessmentFixture, measurementFixture, reconciliationFixture } from './fixtures.test-support';
import { ApprovalForm, AssessmentForm, ProposalForm, ReturnForm } from './WorkflowForms';
import { EvidencePicker } from './shared';
import { PlanForm } from './PlanForm';
import { measurementApi } from './api';
import type { VesselCall } from '../types';
import type { Evidence } from './types';
vi.mock('./api', () => ({ measurementApi: { upload: vi.fn() } }));

describe('measurement entry controls', () => {
  beforeEach(() => vi.clearAllMocks());
  it('retains unknown and explicit NIL as distinct manifest values while adding container lines', async () => {
    render(<PlanForm calls={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
    const manifest = screen.getByLabelText(/Manifest quantity 1/);
    expect(manifest).toHaveValue(null);
    await userEvent.type(manifest, '0');
    expect(manifest).toHaveValue(0);
    await userEvent.selectOptions(screen.getByLabelText('Category 1'), 'Container');
    expect(screen.getByLabelText('Unit 1')).toHaveValue('count');
    await userEvent.selectOptions(screen.getByLabelText('Container size 1'), '40');
    await userEvent.selectOptions(screen.getByLabelText('Load status 1'), 'empty');
    await userEvent.click(screen.getByRole('button', { name: 'Add cargo line' }));
    expect(screen.getByLabelText('Cargo description 2')).toHaveValue('');
    expect(screen.getByLabelText('Container size 1')).toHaveValue('40');
  });
  it('records zero as a real reported quantity and requires source evidence', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={measurementFixture()} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Record stakeholder return' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Source document reference'), 'TERM-001');
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '0');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'party-2', lines: [{ lineId: 'line-1', status: 'reported', quantity: '0', note: '' }], evidenceIds: ['file-1'] })));
  });
  it('requires a revision reason and keeps not-applicable distinct from zero', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={measurementFixture()} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Reporting stakeholder'), 'party-1');
    expect(screen.getByLabelText(/Reason for revision/)).toBeRequired();
    await userEvent.type(screen.getByLabelText(/Reason for revision/), 'Corrected scope');
    await userEvent.type(screen.getByLabelText('Source document reference'), 'AGENT-002');
    await userEvent.selectOptions(screen.getByLabelText('Report status · Wheat'), 'not-applicable');
    expect(screen.getByLabelText('Reported quantity · Wheat')).toBeDisabled();
    expect(screen.getByLabelText('Line note · Wheat')).toBeRequired();
    await userEvent.type(screen.getByLabelText('Line note · Wheat'), 'Outside party scope');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Save revised return' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Corrected scope', lines: [{ lineId: 'line-1', status: 'not-applicable', quantity: null, note: 'Outside party scope' }] })));
  });
  it('requires Finance to choose policy and explicitly verify opening charges', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AssessmentForm plan={measurementFixture()} reconciliation={reconciliationFixture()} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Billing policy')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Calculate and save assessment' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Billing policy'), 'quantity-adjustment');
    const baseline = screen.getByLabelText(/Previously billed quantity/);
    expect(baseline).toHaveValue(null);
    expect(baseline).toBeRequired();
    await userEvent.type(baseline, '19500');
    await userEvent.type(screen.getByLabelText('Payer'), 'Harbour Agent');
    await userEvent.type(screen.getByLabelText('Approved tariff / rate reference'), 'APPROVED-2026');
    await userEvent.type(screen.getByLabelText(/Verified opening charges reference/), 'No prior cargo charges');
    await userEvent.type(screen.getByLabelText('USD rate per tonnes · Wheat'), '10');
    await userEvent.type(screen.getByLabelText('Tolerance (tonnes) · Wheat'), '0');
    await userEvent.type(screen.getByLabelText(/Opening amount already charged/), '0');
    await userEvent.type(screen.getByLabelText('Assessment rationale'), 'Approved excess charge');
    await userEvent.click(screen.getByRole('checkbox', { name: /I have verified/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Calculate and save assessment' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ policy: 'quantity-adjustment', currency: 'USD', openingChargesReference: 'No prior cargo charges', lines: [{ lineId: 'line-1', rate: '10', tolerance: '0', toleranceMode: 'threshold', previouslyBilledQuantity: '19500', openingBilledAmount: '0' }] })));
  });
  it('blocks manifest billing when the declaration is unknown', async () => {
    const plan = measurementFixture(); plan.lines[0].manifestQuantity = null;
    render(<AssessmentForm plan={plan} reconciliation={reconciliationFixture()} onSave={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Billing policy'), 'manifest-disparity');
    expect(within(screen.getByRole('alert')).getByText(/manifest quantity is missing/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /I have verified/ }));
    expect(screen.getByRole('button', { name: 'Calculate and save assessment' })).toBeDisabled();
  });
  it('deduplicates repeated evidence and signals pending upload until every file completes', async () => {
    const plan = measurementFixture(); const onChange = vi.fn(); const busy = vi.fn();
    let finish: (item: Evidence) => void = () => {};
    vi.mocked(measurementApi.upload).mockResolvedValueOnce(plan.evidence[0]).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<EvidencePicker plan={plan} value={['file-1']} onChange={onChange} onBusyChange={busy} />);
    const files = [new File(['first'], 'first.pdf', { type: 'application/pdf' }), new File(['second'], 'second.pdf', { type: 'application/pdf' })];
    await userEvent.upload(screen.getByLabelText('Upload evidence'), files);
    await waitFor(() => expect(measurementApi.upload).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenCalledWith(['file-1']);
    expect(busy).toHaveBeenLastCalledWith(true);
    finish({ ...plan.evidence[0], id: 'file-2' });
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
    expect(onChange).toHaveBeenLastCalledWith(['file-1', 'file-2']);
  });
  it('saves a multi-stakeholder plan with explicit schedule, cargo basis and manifest reference', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PlanForm calls={[{ id: 'call-1', vesselName: 'Atlas', reference: 'CALL-001', status: 'pending' } as VesselCall]} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Vessel call'), 'call-1');
    for (const [label, value] of [['Plan title','Arrival measurement'], ['Terminal / berth','Berth 3'], ['Lead surveyor','Ada'], ['Measurement method','Draft survey'], ['Operation stage','Arrival'], ['Parcel / cargo scope','Parcel B'], ['Planning notes (optional)','Use certified instrument'], ['Cargo description 1','Wheat'], ['Quantity basis 1','Net mass'], ['Manifest / baseline reference 1','BL-001'], ['Party name 1','Agent'], ['Representative 1','Grace']] as const) await userEvent.type(screen.getByLabelText(label), value);
    await userEvent.clear(screen.getByLabelText('Scheduled start', { exact: false }));
    await userEvent.type(screen.getByLabelText('Scheduled start', { exact: false }), '2026-10-01T10:00');
    await userEvent.type(screen.getByLabelText('Scheduled end (optional)'), '2026-10-01T12:00');
    await userEvent.type(screen.getByLabelText(/Manifest quantity 1/), '1000.25');
    await userEvent.selectOptions(screen.getByLabelText('Direction 1'), 'export');
    await userEvent.selectOptions(screen.getByLabelText('Unit 1'), 'm3');
    await userEvent.clear(screen.getByLabelText('Role 1')); await userEvent.type(screen.getByLabelText('Role 1'), 'Master');
    await userEvent.click(screen.getByRole('button', { name: 'Add cargo line' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove cargo line 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add stakeholder' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove stakeholder 2' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Return required' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Agreement required' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create measurement plan' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-1', title: 'Arrival measurement', endsAt: expect.any(String), lines: [expect.objectContaining({ manifestQuantity: '1000.25', direction: 'export', unit: 'm3' })], participants: [expect.objectContaining({ name: 'Agent', role: 'Master', requiredSubmission: false, requiredApproval: false })] })));
  });
  it('records a signed dispute against the named party and exact proposal', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalForm plan={measurementFixture()} reconciliation={reconciliationFixture()} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Acknowledging stakeholder'), 'party-2');
    expect(screen.getByLabelText('Signing representative')).toHaveValue('Tunde');
    await userEvent.clear(screen.getByLabelText('Signing representative'));
    await userEvent.type(screen.getByLabelText('Signing representative'), 'Tunde Master');
    await userEvent.selectOptions(screen.getByLabelText('Decision'), 'disputed');
    await userEvent.type(screen.getByLabelText('Signed document reference / date'), 'DISPUTE-001 / 29 Sep');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Record paper acknowledgement' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ participantId: 'party-2', decision: 'disputed', representative: 'Tunde Master', reference: 'DISPUTE-001 / 29 Sep', evidenceIds: ['file-1'] }));
  });
  it('starts an amendment with prior figures but requires fresh rationale', async () => {
    const plan = measurementFixture(); plan.reconciliations = [reconciliationFixture()];
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProposalForm plan={plan} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Proposed quantity · Wheat')).toHaveValue(19508);
    await userEvent.type(screen.getByLabelText('Reason for new version'), 'Corrected return');
    await userEvent.clear(screen.getByLabelText('Proposed quantity · Wheat'));
    await userEvent.type(screen.getByLabelText('Proposed quantity · Wheat'), '19509');
    await userEvent.type(screen.getByLabelText('Decision rationale · Wheat'), 'Joint verification');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Create revised proposal' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ reason: 'Corrected return', lines: [{ lineId: 'line-1', quantity: '19509', reason: 'Joint verification' }], evidenceIds: ['file-1'] }));
  });
  it('carries forward the issued billing configuration and prevents editing its payer and baseline', () => {
    const plan = measurementFixture(); const issued = assessmentFixture(); issued.status = 'issued'; issued.policy = 'quantity-adjustment'; issued.lines[0].previouslyBilledQuantity = null; plan.assessments = [issued];
    render(<AssessmentForm plan={plan} reconciliation={reconciliationFixture()} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Payer')).toBeDisabled();
    expect(screen.getByLabelText('Billing policy')).toBeDisabled();
    expect(screen.getByLabelText(/Previously billed quantity/)).toHaveValue(19500);
    expect(screen.getByLabelText('USD rate per tonnes · Wheat')).toBeDisabled();
    expect(screen.getByLabelText(/Opening amount already charged/)).toHaveValue(0);
  });

  it('keeps same-named container returns distinguishable and saves their quantities to the correct cargo lines', async () => {
    const plan = measurementFixture(); const base = plan.lines[0];
    plan.lines = [
      { ...base, id: 'containers-20', description: 'Containers', category: 'Container', unit: 'count', direction: 'import', containerSize: '20', loadStatus: 'laden', basis: 'Physical containers' },
      { ...base, id: 'containers-40', description: 'Containers', category: 'Container', unit: 'count', direction: 'export', containerSize: '40', loadStatus: 'empty', basis: 'Physical containers' },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={plan} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Containers · import · 20 ft · laden · count' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Containers · export · 40 ft · empty · count' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Source document reference'), 'CONTAINER-TALLY');
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Reported quantity · Containers · import · 20 ft · laden' }), '70');
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Reported quantity · Containers · export · 40 ft · empty' }), '0');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ lines: [
      { lineId: 'containers-20', status: 'reported', quantity: '70', note: '' },
      { lineId: 'containers-40', status: 'reported', quantity: '0', note: '' },
    ] })));
  });
  it('retains full scope in reconciliation and finance controls for identical cargo descriptions', async () => {
    const plan = measurementFixture(); const base = plan.lines[0];
    plan.lines = [
      { ...base, id: 'containers-20', description: 'Containers', category: 'Container', unit: 'count', direction: 'import', containerSize: '20', loadStatus: 'laden', basis: 'Physical containers' },
      { ...base, id: 'containers-40', description: 'Containers', category: 'Container', unit: 'count', direction: 'export', containerSize: '40', loadStatus: 'empty', basis: 'Physical containers' },
    ];
    const proposal = render(<ProposalForm plan={plan} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: 'Proposed quantity · Containers · import · 20 ft · laden' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'Proposed quantity · Containers · export · 40 ft · empty' })).toHaveValue(null);
    expect(screen.getByLabelText('Decision rationale · Containers · export · 40 ft · empty')).toBeRequired();
    proposal.unmount();
    render(<AssessmentForm plan={plan} reconciliation={reconciliationFixture()} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Containers · import · 20 ft · laden · count' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Containers · export · 40 ft · empty · count' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'USD rate per count · Containers · import · 20 ft · laden' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'USD rate per count · Containers · export · 40 ft · empty' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'Tolerance (count) · Containers · export · 40 ft · empty' })).toBeRequired();
    await userEvent.selectOptions(screen.getByLabelText('Billing policy'), 'quantity-adjustment');
    expect(screen.getByLabelText(/Previously billed quantity · Containers · export · 40 ft · empty/)).toBeRequired();
    expect(screen.getByLabelText(/Opening amount already charged \(USD\) · Containers · import · 20 ft · laden/)).toBeRequired();
  });

});
