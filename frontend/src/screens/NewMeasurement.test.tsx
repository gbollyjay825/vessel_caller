import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewMeasurement } from './Measurements';
import { ApiError } from '../lib/api';
import type { PlanForm } from '../measurements/PlanForm';
import type { AgencyReadingDialog } from '../measurements/AgencyReadingDialog';
import type { AgencyProfile } from '../measurements/agencyDirectory';
import type { CreatedAgencyLink } from '../measurements/AgencyCollection';
import type { MeasurementPlan, ParticipantInput, PlanInput, SubmissionInput } from '../measurements/types';
import { measurementFixture, reconciliationFixture } from '../measurements/fixtures.test-support';

type FormProps = ComponentProps<typeof PlanForm>;
type ReadingProps = ComponentProps<typeof AgencyReadingDialog>;
const mocked = vi.hoisted(() => ({
  create: vi.fn(), detail: vi.fn(), agencyLinks: vi.fn(), createLink: vi.fn(), revokeLink: vi.fn(), submit: vi.fn(),
  navigate: vi.fn(), toast: vi.fn(), can: vi.fn(), storeCan: vi.fn(), saveAgency: vi.fn(),
  orgId: 'org-1', agencies: [] as AgencyProfile[], directoryError: '',
  form: null as FormProps | null, reading: null as ReadingProps | null,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ org: { id: mocked.orgId }, can: mocked.can }) }));
vi.mock('../app/store', () => ({ useStore: () => ({ calls: [], can: mocked.storeCan, toast: mocked.toast }) }));
vi.mock('../lib/navigation', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/navigation')>(),
  useNavigate: () => mocked.navigate,
  useSearchParams: () => [new URLSearchParams('callId=call-1')],
}));
vi.mock('../measurements/agencyDirectory', () => ({ useAgencyDirectory: () => ({ agencies: mocked.agencies, error: mocked.directoryError, saveAgency: mocked.saveAgency }) }));
vi.mock('../measurements/api', () => ({ measurementApi: {
  create: mocked.create, detail: mocked.detail, agencyLinks: mocked.agencyLinks,
  createAgencyLink: mocked.createLink, revokeAgencyLink: mocked.revokeLink, submit: mocked.submit,
} }));
vi.mock('../measurements/PlanForm', () => ({ PlanForm: (props: FormProps) => {
  mocked.form = props;
  return <div aria-label="Voyage form harness"><output data-testid="saved-plan">{props.savedPlan?.id ?? 'unsaved'}</output>{mocked.agencies.map(agency => <div key={agency.id}>{props.renderAgencyAction?.(agency.id)}</div>)}</div>;
} }));
vi.mock('../measurements/AgencyReadingDialog', () => ({ AgencyReadingDialog: (props: ReadingProps) => {
  mocked.reading = props;
  return <div role="dialog" aria-label={`Reading for ${props.participantId}`}><span>{props.plan.title}</span><button type="button" onClick={props.onClose}>Close reading</button></div>;
} }));

const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}><NewMeasurement /></QueryClientProvider>) };
}
function inputFixture(): PlanInput {
  const plan = measurementFixture();
  return {
    callId: plan.callId, title: plan.title, scheduledAt: plan.scheduledAt, endsAt: null,
    location: plan.location, method: plan.method, stage: plan.stage, scope: plan.scope,
    leadSurveyor: plan.leadSurveyor, notes: '',
    participants: plan.participants.map(party => ({ name: party.name, role: party.role, representative: party.representative, requiredSubmission: party.requiredSubmission, requiredApproval: party.requiredApproval })),
    lines: plan.lines.map(line => ({ description: line.description, category: line.category, direction: line.direction, containerSize: line.containerSize, loadStatus: line.loadStatus, unit: line.unit, basis: line.basis, manifestQuantity: line.manifestQuantity, baselineReference: line.baselineReference })),
  };
}
function linkFixture(id = 'link-1', participantId = 'party-1'): CreatedAgencyLink {
  return { link: { id, participantId, expiresAt: '2099-10-12T12:00:00Z', revokedAt: null, submittedAt: null }, url: `https://example.test/agency-reading#token=synthetic-${id}` };
}
function invoke(agencyId = 'agency-agent', action: 'reading' | 'link' = 'reading', input = inputFixture(), source: ParticipantInput = input.participants[0]) {
  return mocked.form!.onAgencyAction!(agencyId, action, input, source);
}
async function actOn(agencyId = 'agency-agent', action: 'reading' | 'link' = 'reading', input = inputFixture(), source: ParticipantInput = input.participants[0]) {
  await act(async () => { await invoke(agencyId, action, input, source); });
}
async function rejectsAction(message: string, input = inputFixture(), source: ParticipantInput = input.participants[0]) {
  await act(async () => { await expect(invoke('agency-agent', 'link', input, source)).rejects.toThrow(message); });
}
function submissionFixture(): SubmissionInput {
  const submission = measurementFixture().submissions[0];
  return { participantId: submission.participantId, observedAt: submission.observedAt, sourceReference: submission.sourceReference, notes: '', reason: '', lines: submission.lines, evidenceIds: submission.evidenceIds };
}
async function publish(client: QueryClient, plan: MeasurementPlan) {
  await act(async () => { client.setQueryData(['measurement-plan', mocked.orgId, plan.id], { plan }); });
  await waitFor(() => expect(mocked.form!.savedPlan).toEqual(plan));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.orgId = 'org-1'; mocked.directoryError = ''; mocked.form = null; mocked.reading = null;
  mocked.agencies = measurementFixture().participants.map((party, index) => ({ id: index === 0 ? 'agency-agent' : 'agency-terminal', name: party.name, role: party.role, representative: party.representative, active: true }));
  mocked.can.mockReturnValue(true); mocked.storeCan.mockReturnValue(true);
  mocked.create.mockResolvedValue({ plan: measurementFixture(), rev: 1 });
  mocked.detail.mockResolvedValue({ plan: measurementFixture() });
  mocked.agencyLinks.mockResolvedValue({ links: [] });
  mocked.createLink.mockResolvedValue(linkFixture());
  mocked.revokeLink.mockResolvedValue({});
  mocked.submit.mockResolvedValue({ plan: { ...measurementFixture(), version: 5 }, rev: 2 });
});
afterEach(() => { clients.splice(0).forEach(client => client.clear()); });

describe('new voyage agency action orchestration', () => {
  it('creates once and matches the voyage representative regardless of server ordering or directory renames', async () => {
    const input = inputFixture(); input.participants[0].representative = ' Voyage delegate ';
    const plan = measurementFixture();
    plan.participants = [plan.participants[1], { ...plan.participants[0], id: 'unrelated-contact' }, { ...plan.participants[0], representative: 'Voyage delegate' }];
    mocked.create.mockResolvedValue({ plan, rev: 1 });
    mocked.agencies[0] = { ...mocked.agencies[0], name: 'Renamed directory entry', representative: 'Different directory contact' };
    setup();
    await actOn('agency-agent', 'reading', input);
    expect(mocked.create).toHaveBeenCalledExactlyOnceWith(input);
    expect(screen.getByRole('dialog', { name: 'Reading for party-1' })).toBeInTheDocument();
    expect(mocked.reading!.plan).toBe(plan);
    await userEvent.click(screen.getByRole('button', { name: 'Close reading' }));
    await actOn('agency-agent', 'link', input);
    expect(mocked.agencyLinks).toHaveBeenCalledExactlyOnceWith('plan-1');
    expect(mocked.createLink).toHaveBeenCalledExactlyOnceWith('plan-1', 'party-1', 7);
    expect(screen.getByRole('region', { name: 'Agency link for Harbour Agent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Link for Harbour Agent')).toHaveValue(linkFixture().url);
    await actOn('agency-agent', 'link', input);
    await actOn('agency-terminal', 'reading', input, input.participants[1]);
    expect(screen.getByRole('dialog', { name: 'Reading for party-2' })).toBeInTheDocument();
    expect(mocked.create).toHaveBeenCalledOnce(); expect(mocked.createLink).toHaveBeenCalledOnce();
    expect(mocked.navigate).not.toHaveBeenCalled();
    act(() => mocked.form!.onFinish!());
    expect(mocked.navigate).toHaveBeenCalledExactlyOnceWith('/app/measurements');
    expect(mocked.create).toHaveBeenCalledOnce();
  });

  it('shares a pending creation across actions instead of creating two voyage sheets', async () => {
    let resolveCreate!: (result: { plan: MeasurementPlan; rev: number }) => void;
    mocked.create.mockImplementationOnce(() => new Promise(resolve => { resolveCreate = resolve; }));
    setup(); const input = inputFixture();
    await act(async () => {
      const first = invoke(); const second = invoke('agency-terminal', 'reading', input, input.participants[1]);
      expect(mocked.create).toHaveBeenCalledOnce();
      resolveCreate({ plan: measurementFixture(), rev: 1 });
      await Promise.all([first, second]);
    });
    expect(mocked.create).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: 'Reading for party-2' })).toBeInTheDocument();
    expect(mocked.navigate).not.toHaveBeenCalled();
  });

  it.each(['missing', 'ambiguous'] as const)('rejects a %s source identity before saving or creating a link', async kind => {
    setup(); const input = inputFixture(); const source = { ...input.participants[0] };
    if (kind === 'missing') source.representative = 'Not selected';
    else input.participants.push({ ...source });
    await rejectsAction('This agency could not be identified.', input, source);
    expect(mocked.create).not.toHaveBeenCalled(); expect(mocked.agencyLinks).not.toHaveBeenCalled(); expect(mocked.createLink).not.toHaveBeenCalled();
  });

  it.each(['wrong name', 'wrong role', 'wrong representative', 'ambiguous'] as const)('rejects a saved agency with %s without falling back to array position', async kind => {
    const plan = measurementFixture();
    if (kind === 'wrong name') plan.participants[0].name = 'Another agency';
    if (kind === 'wrong role') plan.participants[0].role = 'Surveyor';
    if (kind === 'wrong representative') plan.participants[0].representative = 'Another contact';
    if (kind === 'ambiguous') plan.participants.push({ ...plan.participants[0], id: 'duplicate' });
    mocked.create.mockResolvedValue({ plan, rev: 1 }); setup();
    await rejectsAction('The agency setup changed.');
    await rejectsAction('The agency setup changed.');
    expect(mocked.create).toHaveBeenCalledOnce(); expect(mocked.agencyLinks).not.toHaveBeenCalled(); expect(mocked.createLink).not.toHaveBeenCalled();
    expect(mocked.navigate).not.toHaveBeenCalled();
  });

  it('revalidates a cached agency identity after a server update', async () => {
    const { client } = setup(); await actOn();
    const changed = measurementFixture(); changed.participants[0].id = 'replacement-party'; changed.version++;
    await publish(client, changed);
    await rejectsAction('The agency setup changed.');
    expect(mocked.create).toHaveBeenCalledOnce(); expect(mocked.createLink).not.toHaveBeenCalled();
  });

  it.each([
    ['network interruption', () => new Error('Connection lost')],
    ['server error', () => new ApiError('Server failed', 500)],
    ['request timeout', () => new ApiError('Request timed out', 408)],
  ])('does not retry an uncertain save after %s', async (_label, failure) => {
    const error = failure(); mocked.create.mockRejectedValueOnce(error); setup();
    await rejectsAction(error.message);
    expect(screen.getByTestId('saved-plan')).toHaveTextContent('unsaved');
    await rejectsAction('The save could not be confirmed. Check Voyages before starting another sheet.');
    expect(mocked.create).toHaveBeenCalledOnce(); expect(mocked.createLink).not.toHaveBeenCalled(); expect(mocked.navigate).not.toHaveBeenCalled();
  });

  it('allows an explicit retry after a definite validation rejection', async () => {
    mocked.create.mockRejectedValueOnce(new ApiError('Invalid owner declaration', 400)); setup();
    await rejectsAction('Invalid owner declaration');
    expect(mocked.create).toHaveBeenCalledOnce();
    await actOn('agency-agent', 'link');
    expect(mocked.create).toHaveBeenCalledTimes(2); expect(mocked.createLink).toHaveBeenCalledOnce();
  });

  it('keeps the saved voyage usable for readings when secure-link capability is unavailable', async () => {
    mocked.agencyLinks.mockRejectedValueOnce(new ApiError('Not found', 404)); setup();
    await rejectsAction('Secure agency links are not enabled on this server yet.');
    expect(screen.getByTestId('saved-plan')).toHaveTextContent('plan-1');
    expect(mocked.createLink).not.toHaveBeenCalled(); expect(screen.queryByRole('region')).not.toBeInTheDocument();
    await actOn();
    expect(screen.getByRole('dialog', { name: 'Reading for party-1' })).toBeInTheDocument();
    expect(mocked.create).toHaveBeenCalledOnce(); expect(mocked.navigate).not.toHaveBeenCalled();
  });

  it('labels preview links and revokes the displayed replacement without a second voyage save', async () => {
    mocked.agencyLinks.mockResolvedValue({ links: [], uiPreview: true }); setup();
    await actOn('agency-agent', 'link');
    expect(screen.getByText('UI preview · agency links and receipts use local demo records.')).toBeInTheDocument();
    mocked.createLink.mockResolvedValueOnce(linkFixture('link-2'));
    await userEvent.click(screen.getByText('Link options', { selector: 'summary' }));
    await userEvent.click(screen.getByRole('button', { name: 'Replace link' }));
    await waitFor(() => expect(screen.getByLabelText('Link for Harbour Agent')).toHaveValue(linkFixture('link-2').url));
    await userEvent.click(screen.getByText('Link options', { selector: 'summary' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(mocked.revokeLink).toHaveBeenCalledExactlyOnceWith('plan-1', 'link-2'));
    expect(screen.queryByRole('region')).not.toBeInTheDocument(); expect(mocked.create).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'finalized', 'permission removed'] as const)('blocks subsequent actions when the voyage is %s', async kind => {
    const { client, rerender } = setup(); await actOn('agency-agent', 'link');
    const changed = measurementFixture();
    if (kind === 'cancelled') changed.status = 'cancelled';
    else if (kind === 'finalized') changed.reconciliations = [{ ...reconciliationFixture(), status: 'final' }];
    else { mocked.can.mockReturnValue(false); rerender(<QueryClientProvider client={client}><NewMeasurement /></QueryClientProvider>); }
    if (kind !== 'permission removed') await publish(client, changed);
    await rejectsAction('This voyage is no longer open for readings.');
    expect(screen.queryByRole('region')).not.toBeInTheDocument(); expect(mocked.createLink).toHaveBeenCalledOnce(); expect(mocked.create).toHaveBeenCalledOnce();
  });

  it('submits the opened reading, updates the plan and closes the dialog without navigation', async () => {
    setup(); await actOn(); const input = submissionFixture();
    await act(async () => { await mocked.reading!.onSave(input); });
    expect(mocked.submit).toHaveBeenCalledExactlyOnceWith('plan-1', 4, input);
    expect(mocked.form!.savedPlan!.version).toBe(5); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocked.toast).toHaveBeenCalledExactlyOnceWith('Agency reading submitted'); expect(mocked.navigate).not.toHaveBeenCalled();
  });

  it('keeps the opening reading snapshot and rejects its save if a newer plan arrives', async () => {
    const { client } = setup(); await actOn(); const opening = mocked.reading!.plan;
    const changed = { ...measurementFixture(), version: 5, title: 'Updated by another operator', lines: [] };
    await publish(client, changed);
    expect(mocked.reading!.plan).toBe(opening);
    await act(async () => { await expect(mocked.reading!.onSave(submissionFixture())).rejects.toThrow('This voyage changed. Close the reading and reopen it to use the latest record.'); });
    expect(mocked.submit).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close reading' })); await actOn();
    expect(mocked.reading!.plan.version).toBe(5);
  });

  it('rejects another participant and refreshes after a server version conflict', async () => {
    setup(); await actOn();
    await act(async () => { await expect(mocked.reading!.onSave({ ...submissionFixture(), participantId: 'party-2' })).rejects.toThrow('This voyage changed.'); });
    expect(mocked.submit).not.toHaveBeenCalled();
    mocked.submit.mockRejectedValueOnce(new ApiError('Version changed', 409));
    mocked.detail.mockResolvedValueOnce({ plan: { ...measurementFixture(), version: 5 } });
    await act(async () => { await expect(mocked.reading!.onSave(submissionFixture())).rejects.toThrow('Version changed'); });
    expect(mocked.detail).toHaveBeenCalledExactlyOnceWith('plan-1'); expect(mocked.toast).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('drops saved voyage and link state when the organisation changes', async () => {
    const { client, rerender } = setup(); await actOn('agency-agent', 'link');
    mocked.orgId = 'org-2';
    rerender(<QueryClientProvider client={client}><NewMeasurement /></QueryClientProvider>);
    expect(screen.getByTestId('saved-plan')).toHaveTextContent('unsaved'); expect(screen.queryByRole('region')).not.toBeInTheDocument();
    await actOn(); expect(mocked.create).toHaveBeenCalledTimes(2);
  });
});
