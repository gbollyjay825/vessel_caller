import type { ComponentProps, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewMeasurement, suggestedAgencies } from './Measurements';
import type { PlanForm } from '../measurements/PlanForm';
import type { AgencyProfile } from '../measurements/agencyDirectory';
import type { PaidDeclaration, PaidDeclarationInput } from '../measurements/closeoutPreview';
import type { MeasurementPlan, PlanInput } from '../measurements/types';
import type { VesselCall } from '../types';
import { measurementFixture } from '../measurements/fixtures.test-support';

type FormProps = ComponentProps<typeof PlanForm>;
const mocked = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), navigate: vi.fn(), toast: vi.fn(), can: vi.fn(), storeCan: vi.fn(), saveAgency: vi.fn(), saveDeclaration: vi.fn(),
  search: '', orgId: 'org-1', agencies: [] as AgencyProfile[], directoryError: '', calls: [] as VesselCall[],
  declaration: undefined as PaidDeclaration | undefined, voyagePlans: [] as MeasurementPlan[],
  form: null as FormProps | null,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ org: { id: mocked.orgId }, user: { id: 'ops-1', name: 'Ada Operations' }, can: mocked.can }) }));
vi.mock('../app/store', () => ({ useStore: () => ({ calls: mocked.calls, can: mocked.storeCan, toast: mocked.toast }) }));
vi.mock('../lib/navigation', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/navigation')>(),
  useNavigate: () => mocked.navigate,
  useSearchParams: () => [new URLSearchParams(mocked.search)],
}));
vi.mock('../measurements/agencyDirectory', () => ({ useAgencyDirectory: () => ({ agencies: mocked.agencies, error: mocked.directoryError, saveAgency: mocked.saveAgency }) }));
vi.mock('../measurements/api', () => ({ measurementApi: { create: mocked.create, list: mocked.list } }));
vi.mock('../measurements/closeoutPreview', async importOriginal => ({
  ...await importOriginal<typeof import('../measurements/closeoutPreview')>(),
  useCloseoutPreview: () => ({ record: { callId: '', reports: [], invoices: [], events: [], declaration: mocked.declaration }, saveDeclaration: mocked.saveDeclaration }),
}));
vi.mock('../measurements/VoyageWorkspace', () => ({
  useVoyage: () => ({ plans: mocked.voyagePlans }),
  VoyageFrame: ({ step, children }: { step: string; children: ReactNode }) => <section aria-label={`Voyage step ${step}`}>{children}</section>,
}));
vi.mock('../measurements/PlanForm', () => ({ PlanForm: (props: FormProps) => { mocked.form = props; return <div aria-label="Voyage form harness" />; } }));

const vessel: VesselCall = { id: 'call-1', vesselName: 'MV Atlas', reference: 'CALL-001', type: 'Container', flag: 'NG', nrt: 1, eta: '2026-10-07T12:00:00Z', sailingEta: '', berth: 'Berth 3', berthDate: null, status: 'pending', notes: '', version: 1, registered: '2026-10-01' };
const paid: PaidDeclarationInput = { payer: 'Atlas Shipping', agent: '', invoiceReference: 'DEC-1', amountPaid: '100', currency: 'USD', paidOn: '', paymentStatus: 'paid' };
const clients: QueryClient[] = [];
function setup(search = '') {
  mocked.search = search;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { client, invalidate, ...render(<QueryClientProvider client={client}><NewMeasurement /></QueryClientProvider>) };
}
function inputFor(callId = 'call-1'): PlanInput {
  const plan = measurementFixture();
  return { callId, title: plan.title, scheduledAt: plan.scheduledAt, endsAt: null, location: plan.location, method: plan.method, stage: plan.stage, scope: plan.scope, leadSurveyor: plan.leadSurveyor, notes: '', participants: [], lines: [] };
}
function previousVoyage(callId: string, agencyIds: string[], scheduledAt = '2026-09-01T10:00:00Z'): MeasurementPlan {
  const plan = measurementFixture();
  return { ...plan, id: `plan-${callId}-${scheduledAt}`, callId, scheduledAt, participants: agencyIds.map((agencyId, index) => ({ ...plan.participants[0], id: `party-${index}`, agencyId })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.orgId = 'org-1'; mocked.directoryError = ''; mocked.form = null; mocked.declaration = undefined; mocked.voyagePlans = [];
  mocked.calls = [vessel];
  mocked.agencies = [{ id: 'agency-1', name: 'Harbour Agency', role: 'Agent', representative: 'Ada', active: true }];
  mocked.can.mockReturnValue(true); mocked.storeCan.mockReturnValue(true);
  mocked.create.mockResolvedValue({ plan: measurementFixture(), rev: 1 });
  mocked.list.mockResolvedValue({ plans: [] });
});
afterEach(() => { clients.splice(0).forEach(client => client.clear()); });

describe('new voyage entry', () => {
  it('opens the full voyage setup with the directory and permissions', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'New voyage', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Register a new voyage/ })).toHaveAttribute('href', '/app/vessel-calls?register&then=declaration');
    expect(mocked.form).toMatchObject({ callId: undefined, calls: [vessel], agencyCatalog: mocked.agencies, canRegisterVessel: true, canManageAgencies: true, existingSheets: 0 });
    expect(mocked.form!.onCreateAgency).toBeTypeOf('function');
  });

  it('withholds registration and inline agency creation without permission', () => {
    mocked.can.mockReturnValue(false); mocked.storeCan.mockReturnValue(false);
    setup();
    expect(screen.queryByRole('link', { name: /Register a new voyage/ })).not.toBeInTheDocument();
    expect(mocked.form).toMatchObject({ canRegisterVessel: false, canManageAgencies: false, onCreateAgency: undefined });
  });

  it('shows directory errors above the form', () => {
    mocked.directoryError = 'Agencies could not be loaded.';
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent('Agencies could not be loaded.');
  });

  it('creates the voyage, keeps its paid declaration and continues to the agency tracker', async () => {
    const { invalidate } = setup();
    act(() => mocked.form!.onVoyageChange!('call-1'));
    const input = inputFor();
    await act(async () => { await mocked.form!.onSave(input, paid); });
    expect(mocked.create).toHaveBeenCalledExactlyOnceWith(input);
    expect(mocked.saveDeclaration).toHaveBeenCalledExactlyOnceWith(paid, { id: 'ops-1', name: 'Ada Operations' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['measurement-plans'] });
    expect(mocked.toast).toHaveBeenCalledExactlyOnceWith('Voyage created — invite the agencies to report their readings');
    expect(mocked.navigate).toHaveBeenCalledExactlyOnceWith('/app/measurements/voyages/call-1/agencies');
  });

  it('does not attach the paid declaration to a voyage other than the one being edited', async () => {
    setup();
    await act(async () => { await mocked.form!.onSave(inputFor('call-1'), paid); });
    expect(mocked.create).toHaveBeenCalledOnce();
    expect(mocked.saveDeclaration).not.toHaveBeenCalled();
    expect(mocked.navigate).toHaveBeenCalledWith('/app/measurements/voyages/call-1/agencies');
  });

  it('leaves the form open when the voyage cannot be created', async () => {
    mocked.create.mockRejectedValueOnce(new Error('Invalid owner declaration'));
    setup();
    act(() => mocked.form!.onVoyageChange!('call-1'));
    await act(async () => { await expect(mocked.form!.onSave(inputFor(), paid)).rejects.toThrow('Invalid owner declaration'); });
    expect(mocked.saveDeclaration).not.toHaveBeenCalled();
    expect(mocked.toast).not.toHaveBeenCalled();
    expect(mocked.navigate).not.toHaveBeenCalled();
  });

  it('saves new agencies through the directory and reports a failed save', async () => {
    const created: AgencyProfile = { id: 'agency-2', name: 'Checker', role: 'Surveyor', representative: '', active: true };
    mocked.saveAgency.mockResolvedValueOnce(created).mockResolvedValueOnce(null);
    setup();
    const input = { name: 'Checker', role: 'Surveyor', representative: '' };
    await expect(mocked.form!.onCreateAgency!(input)).resolves.toBe(created);
    expect(mocked.saveAgency).toHaveBeenCalledWith({ ...input, active: true });
    await expect(mocked.form!.onCreateAgency!(input)).rejects.toThrow('Agency could not be saved. Check agency setup and try again.');
  });

  it('returns to the voyage list on cancel', () => {
    setup();
    act(() => mocked.form!.onCancel());
    expect(mocked.navigate).toHaveBeenCalledExactlyOnceWith('/app/measurements');
  });
});

describe('declaration step of an existing voyage', () => {
  it('fixes the voyage, prefills the saved paid declaration and suggests the last voyage’s agencies', async () => {
    mocked.declaration = { ...paid, updatedAt: '2026-10-01T10:00:00Z', updatedBy: { id: 'ops-1', name: 'Ada Operations' } };
    mocked.calls = [vessel, { ...vessel, id: 'call-0', reference: 'CALL-000' }];
    mocked.list.mockResolvedValue({ plans: [previousVoyage('call-0', ['agency-1', 'agency-2'])] });
    setup('callId=call-1');
    expect(screen.getByRole('region', { name: 'Voyage step declaration' })).toBeInTheDocument();
    expect(mocked.form).toMatchObject({ callId: 'call-1', existingSheets: 0, paid });
    await waitFor(() => expect(mocked.form!.suggestedAgencyIds).toEqual(['agency-1', 'agency-2']));
  });

  it('warns about an existing declaration and cancels back to the voyage', () => {
    mocked.voyagePlans = [measurementFixture()];
    setup('callId=call-1');
    expect(mocked.form).toMatchObject({ callId: 'call-1', existingSheets: 1 });
    act(() => mocked.form!.onCancel());
    expect(mocked.navigate).toHaveBeenCalledExactlyOnceWith('/app/measurements/voyages/call-1/declaration');
  });
});

describe('suggested agencies', () => {
  const calls: VesselCall[] = [vessel, { ...vessel, id: 'call-0' }, { ...vessel, id: 'call-older' }, { ...vessel, id: 'other', vesselName: 'MV Other' }, { ...vessel, id: 'other-flag', flag: 'GH' }];
  it('uses the same vessel’s most recent other voyage only', () => {
    const plans = [
      previousVoyage('call-older', ['agency-old'], '2026-08-01T10:00:00Z'),
      previousVoyage('call-0', ['agency-1', 'agency-1', 'agency-2']),
      previousVoyage('other', ['agency-other'], '2026-10-01T10:00:00Z'),
      previousVoyage('other-flag', ['agency-flag'], '2026-10-01T10:00:00Z'),
      previousVoyage('call-1', ['agency-self'], '2026-10-02T10:00:00Z'),
    ];
    expect(suggestedAgencies('call-1', calls, plans)).toEqual(['agency-1', 'agency-2']);
  });
  it('ignores cancelled voyages, agencies without a directory id and unknown calls', () => {
    const cancelled = { ...previousVoyage('call-0', ['agency-cancelled'], '2026-09-20T10:00:00Z'), status: 'cancelled' as const };
    const manual = previousVoyage('call-older', ['agency-2']);
    manual.participants.push({ ...manual.participants[0], id: 'manual', agencyId: undefined });
    expect(suggestedAgencies('call-1', calls, [cancelled, manual])).toEqual(['agency-2']);
    expect(suggestedAgencies('missing', calls, [manual])).toEqual([]);
  });
});
