import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeasurementDetail, Measurements, ComparisonGrid } from './Measurements';
import { assessmentFixture, measurementFixture, reconciliationFixture } from '../measurements/fixtures.test-support';
import { finalizationIssues } from '../measurements/helpers';
const mocked = vi.hoisted(() => ({ can: vi.fn(), detail: vi.fn(), list: vi.fn(), propose: vi.fn(), update: vi.fn(), finalize: vi.fn(), assess: vi.fn(), issue: vi.fn(), evidence: vi.fn(), userId: 'admin-1' }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ org: { id: 'org-1' }, user: { id: mocked.userId }, can: mocked.can }) }));
vi.mock('../app/store', () => ({ useStore: () => ({ toast: vi.fn() }) }));
vi.mock('../lib/navigation', async importOriginal => ({ ...await importOriginal<typeof import('../lib/navigation')>(), useParams: () => ({ id: 'plan-1' }) }));
vi.mock('../measurements/api', () => ({ measurementApi: { detail: mocked.detail, list: mocked.list, propose: mocked.propose, update: mocked.update, finalize: mocked.finalize, assess: mocked.assess, issue: mocked.issue, evidence: mocked.evidence, documentUrl: () => '/document' } }));
const renderScreen = (element: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider>);

describe('measurement workflow', () => {
  beforeEach(() => { mocked.can.mockReturnValue(true); mocked.userId = 'admin-1'; mocked.detail.mockResolvedValue({ plan: measurementFixture() }); mocked.list.mockResolvedValue({ plans: [measurementFixture()] }); });
  it('exposes an actionable plan worklist and search', async () => {
    renderScreen(<Measurements />);
    expect(await screen.findByRole('link', { name: /Discharge survey/ })).toHaveAttribute('href', '/app/measurements/plan-1');
    await userEvent.type(screen.getByLabelText('Search vessels or voyages'), 'unknown');
    expect(screen.getByText('No voyages found')).toBeInTheDocument();
  });
  it('shows missing party returns separately from reported quantities', () => {
    render(<ComparisonGrid plan={measurementFixture()} />);
    expect(screen.getByText('19,508')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });
  it('places the owner baseline and agencies before independent measurement arrangements', async () => {
    renderScreen(<MeasurementDetail />);
    await screen.findByRole('heading', { name: 'Discharge survey' });
    expect(screen.getByRole('tab', { name: 'Vessel baseline' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
      'Vessel & voyage', 'Owner’s baseline declaration', 'Participating agencies', 'Independent measurement arrangements',
    ]);
    expect(screen.getByText(/Each named agency supplies an independent measurement before NPA reconciles/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Agency readings/ }));
    expect(screen.getByRole('heading', { name: 'Independent agency readings' })).toBeInTheDocument();
    expect(screen.getByText(/The owner’s declaration is the baseline/)).toBeInTheDocument();
  });
  it('gates proposal on missing required returns and assessment on final approval', async () => {
    renderScreen(<MeasurementDetail />);
    await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
    expect(screen.getByRole('button', { name: 'Propose reconciliation' })).toBeDisabled();
    expect(screen.getByText('Terminal One: required return missing.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Disparity billing' }));
    expect(screen.getByRole('button', { name: 'Assess disparity' })).toBeDisabled();
  });
  it('requires an agency reading before reconciliation even when all returns are optional', async () => {
    const plan = measurementFixture();
    plan.participants = plan.participants.map(party => ({ ...party, requiredSubmission: false }));
    plan.submissions = [];
    mocked.detail.mockResolvedValue({ plan });
    renderScreen(<MeasurementDetail />);
    await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
    expect(screen.getByRole('button', { name: 'Propose reconciliation' })).toBeDisabled();
    expect(screen.getByText('Record at least one agency measurement before NPA reconciliation.')).toBeInTheDocument();
  });
  it('requires an independent Admin and fresh submission snapshot', () => {
    const plan = measurementFixture(); const recon = reconciliationFixture();
    recon.approvals = plan.participants.map(party => ({ id: party.id, participantId: party.id, decision: 'agreed', representative: party.representative, reference: 'Signed', evidenceIds: ['file-1'], recordedBy: { id: 'ops-1', name: 'Ada' }, recordedAt: '2026-09-29T11:00:00Z' }));
    expect(finalizationIssues(plan, recon, 'ops-1')).toContain('An independent Admin must finalize this proposal. You prepared this version.');
    expect(finalizationIssues(plan, recon, 'admin-1')).toEqual([]);
    plan.submissions.push({ ...plan.submissions[0], id: 'sub-2', revision: 2 });
    expect(finalizationIssues(plan, recon, 'admin-1')).toContain('Returns changed after this proposal. Create a refreshed proposal before approval.');
  });
  it('keeps final historical comparison tied to original return revisions', () => {
    const plan = measurementFixture(); const recon = reconciliationFixture();
    plan.submissions.push({ ...plan.submissions[0], id: 'sub-2', revision: 2, lines: [{ lineId: 'line-1', status: 'reported', quantity: '20000.000', note: '' }] });
    render(<ComparisonGrid plan={plan} reconciliation={recon} snapshot />);
    expect(screen.queryByText('20,000')).not.toBeInTheDocument();
    expect(screen.getAllByText('19,508')).toHaveLength(2);
  });
  it('retains the opening version when another user changes a plan during proposal entry', async () => {
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: 'sub-terminal', participantId: 'party-2' });
    mocked.detail.mockResolvedValue({ plan });
    mocked.propose.mockRejectedValue(new Error('Stale plan version'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MeasurementDetail /></QueryClientProvider>);
    await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Propose reconciliation' }));
    await userEvent.type(screen.getByLabelText('Reconciliation rationale'), 'Joint survey agreed');
    await userEvent.type(screen.getByLabelText('Proposed quantity · Wheat'), '19508');
    await userEvent.type(screen.getByLabelText('Decision rationale · Wheat'), 'Verified survey');
    act(() => client.setQueryData(['measurement-plan', 'org-1', 'plan-1'], { plan: { ...plan, version: 5 } }));
    expect(await screen.findByText(/This plan changed while the action was open/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create reconciliation proposal' }));
    await waitFor(() => expect(mocked.propose).toHaveBeenCalledWith('plan-1', 4, expect.objectContaining({ reason: 'Joint survey agreed' })));
  });
  it('hides operational and finance mutations from Viewers', async () => {
    mocked.can.mockReturnValue(false);
    renderScreen(<MeasurementDetail />);
    await screen.findByRole('heading', { name: 'Discharge survey' });
    expect(screen.queryByRole('button', { name: 'Edit schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record return' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Disparity billing' }));
    expect(screen.queryByRole('button', { name: 'Assess disparity' })).not.toBeInTheDocument();
  });
  it('allows an independent Admin to finalize, then Finance to assess and issue with all source history retained', async () => {
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: 'sub-terminal', participantId: 'party-2', reason: 'Corrected terminal tally', notes: 'Witnessed unloading' });
    const recon = reconciliationFixture(); recon.submissionIds = plan.submissions.map(item => item.id);
    recon.approvals = plan.participants.map(party => ({ id: party.id, participantId: party.id, decision: 'agreed', representative: party.representative, reference: 'Signed sheet 29 Sep', evidenceIds: ['file-1'], recordedBy: { id: 'ops-1', name: 'Ada' }, recordedAt: '2026-09-29T11:30:00Z' }));
    plan.reconciliations = [recon];
    const final = { ...recon, status: 'final' as const, finalizedBy: { id: 'admin-1', name: 'Admin Reviewer' }, finalizedAt: '2026-09-29T12:00:00Z' };
    const finalPlan = { ...plan, status: 'reconciled' as const, version: 5, reconciliations: [final] };
    const assessment = assessmentFixture();
    const assessedPlan = { ...finalPlan, version: 6, assessments: [assessment] };
    const issuedPlan = { ...assessedPlan, version: 7, assessments: [{ ...assessment, status: 'issued' as const, invoiceId: 'invoice-1' }] };
    mocked.detail.mockResolvedValue({ plan });
    mocked.finalize.mockResolvedValue({ plan: finalPlan, rev: 5 });
    mocked.assess.mockResolvedValue({ plan: assessedPlan, rev: 6 });
    mocked.issue.mockResolvedValue({ plan: issuedPlan, rev: 7 });
    mocked.evidence.mockResolvedValue({ downloadUrl: 'https://storage.example/evidence' });
    renderScreen(<MeasurementDetail />);
    await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Review & finalize v1' }));
    expect(screen.getByText(/You are approving reconciliation v1 prepared by Ada Operations/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finalize version 1' }));
    await waitFor(() => expect(mocked.finalize).toHaveBeenCalledWith('plan-1', 'recon-1', 4));
    expect(await screen.findByRole('link', { name: 'Final sheet v1' })).toHaveAttribute('href', '/document');
    await userEvent.click(screen.getByRole('tab', { name: 'Disparity billing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Assess disparity' }));
    await userEvent.selectOptions(screen.getByLabelText('Billing policy'), 'manifest-disparity');
    for (const [label, value] of [['Payer','Harbour Agent'], ['Approved tariff / rate reference','TARIFF-2026'], ['USD rate per tonnes · Wheat','10'], ['Tolerance (tonnes) · Wheat','0'], ['Assessment rationale','Approved excess charge']] as const) await userEvent.type(screen.getByLabelText(label), value);
    await userEvent.type(screen.getByLabelText(/Verified opening charges reference/), 'No prior cargo charges');
    await userEvent.type(screen.getByLabelText(/Opening amount already charged/), '0');
    await userEvent.selectOptions(screen.getByLabelText('Tolerance treatment · Wheat'), 'deductible');
    await userEvent.click(screen.getByRole('checkbox', { name: /I have verified/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Calculate and save assessment' }));
    await waitFor(() => expect(mocked.assess).toHaveBeenCalledWith('plan-1', 5, expect.objectContaining({ policy: 'manifest-disparity' })));
    await userEvent.click(await screen.findByRole('button', { name: 'Review & issue invoice' }));
    await userEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    await waitFor(() => expect(mocked.issue).toHaveBeenCalledWith('plan-1', 'assessment-1', 6));
    expect(await screen.findByRole('link', { name: 'View invoice' })).toHaveAttribute('href', '/app/invoices?focus=invoice-1');
    await userEvent.click(screen.getByRole('tab', { name: 'Documents & history' }));
    await userEvent.click(screen.getByText('Version 1', { exact: true }));
    expect(screen.getByRole('link', { name: 'Download version 1 sheet' })).toHaveAttribute('href', '/document');
    await userEvent.click(screen.getByText('Terminal One', { selector: 'summary strong' }));
    expect(screen.getByText('Revision reason: Corrected terminal tally')).toBeInTheDocument();
    expect(screen.getByText('Witnessed unloading')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'View file' })[0]);
    expect(await screen.findByRole('link', { name: /Open file/ })).toHaveAttribute('href', 'https://storage.example/evidence');
    await userEvent.click(screen.getByText('USD 80', { selector: 'summary strong' }));
    expect(screen.getByRole('link', { name: 'View invoice' })).toBeInTheDocument();
  });
  it.each(['held', 'no-charge', 'superseded'] as const)('shows %s assessments without an issue action', async status => {
    const plan = measurementFixture(); const recon = reconciliationFixture(); recon.status = 'final'; recon.finalizedAt = '2026-09-29T12:00:00Z'; plan.reconciliations = [recon];
    const assessment = assessmentFixture(); assessment.policy = 'quantity-adjustment';
    if (status === 'superseded') assessment.superseded = true; else assessment.status = status;
    plan.assessments = [assessment]; mocked.detail.mockResolvedValue({ plan });
    renderScreen(<MeasurementDetail />); await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('tab', { name: 'Disparity billing' }));
    expect(screen.getByText(status.replaceAll('-', ' '))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review & issue invoice' })).not.toBeInTheDocument();
    if (status === 'held') expect(screen.getByText(/held for credit or adjustment review/)).toBeInTheDocument();
    if (status === 'no-charge') expect(screen.getByText(/No additional charge is due/)).toBeInTheDocument();
  });
  it('reschedules and cancels a plan through explicit audited actions', async () => {
    const plan = measurementFixture(); mocked.update.mockResolvedValue({ plan: { ...plan, version: 5 }, rev: 5 });
    renderScreen(<MeasurementDetail />); await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit schedule' }));
    await userEvent.clear(screen.getByLabelText('Plan title')); await userEvent.type(screen.getByLabelText('Plan title'), 'Revised survey');
    await userEvent.clear(screen.getByLabelText('Terminal / berth')); await userEvent.type(screen.getByLabelText('Terminal / berth'), 'Berth 4');
    await userEvent.clear(screen.getByLabelText('Lead surveyor')); await userEvent.type(screen.getByLabelText('Lead surveyor'), 'Tunde');
    await userEvent.type(screen.getByLabelText('Scheduled end (optional)'), '2026-10-01T12:00');
    await userEvent.type(screen.getByLabelText('Planning notes'), 'Weather delay');
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mocked.update).toHaveBeenCalledWith('plan-1', expect.objectContaining({ title: 'Revised survey', version: 4, location: 'Berth 4', notes: 'Weather delay' })));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel measurement plan' }));
    await userEvent.type(screen.getByLabelText('Cancellation reason'), 'Cargo operation cancelled');
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel measurement plan' })[0]);
    await waitFor(() => expect(mocked.update).toHaveBeenCalledWith('plan-1', { version: 5, status: 'cancelled', reason: 'Cargo operation cancelled' }));
  });

  it('shows complete container context in saved assessments and historical line decisions and returns', async () => {
    const plan = measurementFixture();
    plan.lines[0] = { ...plan.lines[0], description: 'Containers', category: 'Container', unit: 'count', direction: 'import', containerSize: '20', loadStatus: 'laden', basis: 'Physical containers' };
    const recon = reconciliationFixture(); recon.status = 'final'; recon.finalizedAt = '2026-09-29T12:00:00Z'; plan.reconciliations = [recon];
    const assessment = assessmentFixture(); assessment.lines[0] = { ...assessment.lines[0], description: 'Containers', unit: 'count', direction: 'import', containerSize: '20', loadStatus: 'laden', basis: 'Physical containers' }; plan.assessments = [assessment];
    mocked.detail.mockResolvedValue({ plan });
    renderScreen(<MeasurementDetail />); await screen.findByRole('heading', { name: 'Discharge survey' });
    await userEvent.click(screen.getByRole('tab', { name: 'Disparity billing' }));
    expect(screen.getByText('count · import · 20 ft · laden · Physical containers')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }));
    expect(screen.getByText('Containers · import · 20 ft · laden:', { selector: '.measurement-decision strong' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Documents & history' }));
    await userEvent.click(screen.getByText('Harbour Agent', { selector: 'summary strong' }));
    expect(screen.getByText('Containers · import · 20 ft · laden: 19,508', { selector: 'li' })).toBeInTheDocument();
  });

});
