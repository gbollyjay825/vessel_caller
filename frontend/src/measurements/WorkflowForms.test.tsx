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
const auth = vi.hoisted(() => ({ user: { id: 'recorder-1', name: 'Mariam Recorder', role: 'Operations' } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));

describe('measurement entry controls', () => {
  beforeEach(() => vi.clearAllMocks());
  it('retains unknown and explicit NIL as distinct declaration values while adding container items', async () => {
    render(<PlanForm calls={[{ id: 'call-1', vesselName: 'Atlas', reference: 'CALL-001', status: 'pending' } as VesselCall]} callId="call-1" onSave={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const manifest = screen.getByLabelText(/Manifest quantity 1/);
    expect(manifest).toHaveValue(null);
    await userEvent.selectOptions(screen.getByLabelText('Category 1'), 'Container');
    await userEvent.type(manifest, '0');
    expect(manifest).toHaveValue(0);
    expect(screen.getByLabelText('Unit 1')).toHaveValue('count');
    await userEvent.selectOptions(screen.getByLabelText('Container size 1'), '40');
    await userEvent.selectOptions(screen.getByLabelText('Load status 1'), 'empty');
    await userEvent.click(screen.getByRole('button', { name: 'Add Bulk' }));
    expect(screen.getByLabelText('Cargo description 2')).toHaveValue('');
    expect(screen.getByLabelText('Container size 1')).toHaveValue('40');
  });
  it('submits a staff return without attachments while preserving explicit zero', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={measurementFixture()} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Supporting evidence (optional)' })).toBeInTheDocument();
    expect(screen.getByText('You can submit this reading without an attachment.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Source document reference')).toBeRequired();
    await userEvent.type(screen.getByLabelText('Source document reference'), 'TERM-001');
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'party-2', lines: [{ lineId: 'line-1', status: 'reported', quantity: '0', note: '' }], evidenceIds: [] })));
  });
  it('submits a direct agency reading without attachments, fixed to its selected participant', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={measurementFixture()} initialParticipantId="party-2" fixedAgency collectionOnly onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Reporting agency')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Source document reference'), 'TERMINAL-READING');
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Submit reading' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'party-2', evidenceIds: [] })));
  });
  it('fails closed when the selected direct agency no longer exists', () => {
    render(<ReturnForm plan={measurementFixture()} initialParticipantId="deleted-party" fixedAgency collectionOnly onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Reporting agency')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit reading' })).toBeDisabled();
    expect(screen.getByText('Choose an agency')).toBeInTheDocument();
  });
  it('preserves the draft and blocks saving when cargo IDs change while a form is open', async () => {
    const plan = measurementFixture();
    const { rerender } = render(<ReturnForm plan={plan} initialParticipantId="party-2" fixedAgency collectionOnly onSave={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Source document reference'), 'RETAINED-REF');
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '100');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    rerender(<ReturnForm plan={{ ...plan, version: plan.version + 1, lines: [{ ...plan.lines[0], id: 'replacement-line' }] }} initialParticipantId="party-2" fixedAgency collectionOnly onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Source document reference')).toHaveValue('RETAINED-REF');
    expect(screen.getByRole('button', { name: 'Submit reading' })).toBeDisabled();
  });
  it('requires a revision reason and keeps not-applicable distinct from zero', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={measurementFixture()} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Reporting agency'), 'party-1');
    expect(screen.getByLabelText(/Reason for revision/)).toBeRequired();
    await userEvent.type(screen.getByLabelText(/Reason for revision/), 'Corrected scope');
    await userEvent.clear(screen.getByLabelText('Source document reference'));
    await userEvent.type(screen.getByLabelText('Source document reference'), 'AGENT-002');
    await userEvent.selectOptions(screen.getByLabelText('Report status · Wheat'), 'not-applicable');
    expect(screen.getByLabelText('Reported quantity · Wheat')).toBeDisabled();
    expect(screen.getByLabelText('Line note · Wheat')).toBeRequired();
    await userEvent.type(screen.getByLabelText('Line note · Wheat'), 'Outside party scope');
    expect(screen.getByLabelText('signed-survey.pdf')).toBeChecked();
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
  it('saves a voyage sheet with an explicit schedule, cargo basis and agency participation requirements', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PlanForm calls={[{ id: 'call-1', vesselName: 'Atlas', reference: 'CALL-001', status: 'pending' } as VesselCall]} callId="call-1" agencyCatalog={[{ id: 'agency-1', name: 'Agent', role: 'Master', representative: 'Grace', active: true }]} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByText('Voyage details (optional)', { selector: 'summary' }));
    for (const [label, value] of [['Terminal / berth','Berth 3'], ['Lead surveyor','Ada'], ['Voyage notes (optional)','Use certified instrument']] as const) { await userEvent.clear(screen.getByLabelText(label)); await userEvent.type(screen.getByLabelText(label), value); }
    await userEvent.clear(screen.getByLabelText('Scheduled start', { exact: false }));
    await userEvent.type(screen.getByLabelText('Scheduled start', { exact: false }), '2026-10-01T10:00');
    await userEvent.type(screen.getByLabelText('Scheduled end (optional)'), '2026-10-01T12:00');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.type(screen.getByLabelText('Cargo description 1'), 'Wheat');
    await userEvent.click(screen.getByLabelText('Quantity basis for item 1'));
    await userEvent.clear(screen.getByLabelText('Quantity basis 1'));
    await userEvent.type(screen.getByLabelText('Quantity basis 1'), 'Net mass');
    await userEvent.type(screen.getByLabelText('Manifest / baseline reference 1'), 'BL-001');
    await userEvent.selectOptions(screen.getByLabelText('Unit 1'), 'm3');
    await userEvent.type(screen.getByLabelText('Manifest quantity 1'), '1000.25');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select agency Agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create voyage sheet' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-1', title: 'Bulk discharge tally · Atlas · CALL-001', endsAt: expect.any(String), lines: [expect.objectContaining({ manifestQuantity: '1000.25', direction: 'import', unit: 'm3' })], participants: [expect.objectContaining({ name: 'Agent', role: 'Master', requiredSubmission: true, requiredApproval: true })] })));
  });
  it('records a signed dispute against the named party and exact proposal', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalForm plan={measurementFixture()} reconciliation={reconciliationFixture()} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Supporting evidence' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Supporting evidence (optional)' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record paper acknowledgement' })).toBeDisabled();
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

  it('separates the selected agency from the authenticated person entering the return', async () => {
    render(<ReturnForm plan={measurementFixture()} onSave={vi.fn()} onCancel={vi.fn()} />);
    const agency = screen.getByText('Selected agency').closest('div')!;
    const recorder = screen.getByText('Entered by').closest('div')!;
    expect(within(agency).getByText('Terminal One')).toBeInTheDocument();
    expect(within(agency).getByText('Terminal operator')).toBeInTheDocument();
    expect(within(recorder).getByText('Mariam Recorder')).toBeInTheDocument();
    expect(within(recorder).getByText('Operations')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Reporting agency'), 'party-1');
    expect(within(agency).getByText('Harbour Agent')).toBeInTheDocument();
    expect(within(recorder).getByText('Mariam Recorder')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Agency’s measured quantity' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Owner declaration.*Owner-provided baseline/ })).toBeInTheDocument();
  });

  it('keeps NIL, unknown declaration, blank readings and not applicable distinct', async () => {
    const plan = measurementFixture(); plan.lines[0].manifestQuantity = null;
    const onSave = vi.fn();
    render(<ReturnForm plan={plan} onSave={onSave} onCancel={vi.fn()} />);
    const sheet = screen.getByRole('region', { name: 'Agency measurement entry sheet' });
    expect(within(sheet).getByText('Not provided')).toBeInTheDocument();
    expect(within(sheet).getByText('Unknown · enter a reading')).toBeInTheDocument();
    expect(within(sheet).getByText('Awaiting reading')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Source document reference'), 'TERMINAL-NIL');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '0');
    expect(within(sheet).getByText('NIL · explicit zero')).toBeInTheDocument();
    expect(within(sheet).getByText('Owner declaration not provided')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Report status · Wheat'), 'not-applicable');
    expect(screen.getByLabelText('Reported quantity · Wheat')).toHaveValue(null);
    expect(screen.getByLabelText('Reported quantity · Wheat')).toBeDisabled();
    expect(screen.getByLabelText('Line note · Wheat')).toBeRequired();
    expect(within(sheet).getByText('N/A · no quantity')).toBeInTheDocument();
    expect(within(sheet).getByText('Not comparable')).toBeInTheDocument();
    expect(within(sheet).queryByText('NIL · explicit zero')).not.toBeInTheDocument();
  });

  it('preserves separate agency drafts, clones revised returns and submits the selected agency only', async () => {
    const plan = measurementFixture(); plan.submissions[0].notes = 'Original agency note';
    plan.submissions[0].lines[0].note = 'Original survey';
    const original = JSON.stringify(plan.submissions);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={plan} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Source document reference'), 'TERMINAL-NEW');
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '0');
    await userEvent.type(screen.getByLabelText('Line note · Wheat'), 'Terminal NIL');
    await userEvent.type(screen.getByLabelText('Return notes (optional)'), 'Terminal note');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.selectOptions(screen.getByLabelText('Reporting agency'), 'party-1');
    expect(screen.getByLabelText('Source document reference')).toHaveValue('AGENT-001');
    expect(screen.getByLabelText('Reported quantity · Wheat')).toHaveValue(19508);
    expect(screen.getByLabelText('Line note · Wheat')).toHaveValue('Original survey');
    expect(screen.getByLabelText('Return notes (optional)')).toHaveValue('Original agency note');
    expect(screen.getByLabelText(/Reason for revision/)).toHaveValue('');
    expect(screen.getByLabelText('signed-survey.pdf')).toBeChecked();
    await userEvent.clear(screen.getByLabelText('Reported quantity · Wheat'));
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '19509');
    await userEvent.type(screen.getByLabelText(/Reason for revision/), 'Revised survey');
    await userEvent.click(screen.getByLabelText('signed-survey.pdf'));
    await userEvent.selectOptions(screen.getByLabelText('Reporting agency'), 'party-2');
    expect(screen.getByLabelText('Reported quantity · Wheat')).toHaveValue(0);
    expect(screen.getByLabelText('Source document reference')).toHaveValue('TERMINAL-NEW');
    expect(screen.getByLabelText('Line note · Wheat')).toHaveValue('Terminal NIL');
    expect(screen.getByLabelText('Return notes (optional)')).toHaveValue('Terminal note');
    expect(screen.queryByLabelText(/Reason for revision/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('signed-survey.pdf')).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'party-2', sourceReference: 'TERMINAL-NEW', reason: '', notes: 'Terminal note', evidenceIds: ['file-1'], lines: [{ lineId: 'line-1', status: 'reported', quantity: '0', note: 'Terminal NIL' }] })));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('recordedBy');
    expect(JSON.stringify(plan.submissions)).toBe(original);
    await userEvent.selectOptions(screen.getByLabelText('Reporting agency'), 'party-1');
    expect(screen.getByLabelText('Reported quantity · Wheat')).toHaveValue(19509);
    expect(screen.getByLabelText(/Reason for revision/)).toHaveValue('Revised survey');
    expect(screen.getByLabelText('signed-survey.pdf')).not.toBeChecked();
  });

  it('shows precise per-line differences and treats a NIL declaration as known', async () => {
    const plan = measurementFixture(); plan.lines[0].manifestQuantity = '0.000';
    render(<ReturnForm plan={plan} onSave={vi.fn()} onCancel={vi.fn()} />);
    const sheet = screen.getByRole('region', { name: 'Agency measurement entry sheet' });
    expect(within(sheet).getByText('NIL (0)')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '0.001');
    expect(within(sheet).getByText('+0.001')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Reported quantity · Wheat'));
    expect(within(sheet).getByText('Awaiting reading')).toBeInTheDocument();
    expect(within(sheet).queryByText('+0.001')).not.toBeInTheDocument();
  });

  it('waits for optional uploads and includes the uploaded evidence in the selected agency submission', async () => {
    const plan = measurementFixture(); let finish: (item: Evidence) => void = () => {};
    vi.mocked(measurementApi.upload).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReturnForm plan={plan} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Source document reference'), 'UPLOADED-REF');
    await userEvent.type(screen.getByLabelText('Reported quantity · Wheat'), '120');
    await userEvent.upload(screen.getByLabelText('Upload evidence'), new File(['source'], 'terminal.pdf', { type: 'application/pdf' }));
    expect(screen.getByLabelText('Reporting agency')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record stakeholder return' })).toBeDisabled();
    finish({ ...plan.evidence[0], id: 'file-terminal', fileName: 'terminal.pdf' });
    await waitFor(() => expect(screen.getByLabelText('Reporting agency')).toBeEnabled());
    expect(screen.getByLabelText('terminal.pdf')).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Record stakeholder return' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'party-2', evidenceIds: ['file-terminal'], sourceReference: 'UPLOADED-REF' })));
    await userEvent.selectOptions(screen.getByLabelText('Reporting agency'), 'party-1');
    expect(screen.getByLabelText('terminal.pdf')).not.toBeChecked();
  });

  it('reviews latest agency readings without overwriting them or choosing a final quantity automatically', async () => {
    const plan = measurementFixture();
    plan.participants.push({ ...plan.participants[0], id: 'party-3', name: 'Independent Surveyor', role: 'Surveyor' });
    plan.submissions.push({ ...plan.submissions[0], id: 'sub-v2', revision: 2, sourceReference: 'AGENT-002', lines: [{ lineId: 'line-1', status: 'reported', quantity: '0.000', note: 'Confirmed NIL' }] });
    plan.submissions.push({ ...plan.submissions[0], id: 'sub-terminal', participantId: 'party-2', sourceReference: 'TERMINAL-001', lines: [{ lineId: 'line-1', status: 'not-applicable', quantity: null, note: 'Outside scope' }] });
    const original = JSON.stringify(plan.submissions); const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProposalForm plan={plan} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'NPA reconciliation review' })).toBeInTheDocument();
    const readings = screen.getByRole('region', { name: 'Agency readings · Wheat' });
    for (const value of ['NIL (0)', 'v2 · AGENT-002', '-19500', 'Confirmed NIL', 'N/A', 'Not comparable', 'Awaiting return']) expect(within(readings).getByText(value)).toBeInTheDocument();
    expect(within(readings).queryByText('19,508')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Proposed quantity · Wheat')).toHaveValue(null);
    await userEvent.type(screen.getByLabelText('Reconciliation rationale'), 'Joint review');
    await userEvent.type(screen.getByLabelText('Proposed quantity · Wheat'), '0');
    await userEvent.type(screen.getByLabelText('Decision rationale · Wheat'), 'NIL agreed after review');
    await userEvent.click(screen.getByRole('button', { name: 'Create reconciliation proposal' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ reason: 'Joint review', evidenceIds: [], lines: [{ lineId: 'line-1', quantity: '0', reason: 'NIL agreed after review' }] }));
    expect(JSON.stringify(plan.submissions)).toBe(original);
  });

});
