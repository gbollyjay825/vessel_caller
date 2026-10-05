import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measurementApi } from './api';
import { ApiError, request } from '../lib/api';
import type { ApprovalInput, AssessmentInput, PlanInput, ReconciliationInput, SubmissionInput } from './types';
vi.mock('../lib/api', async original => ({ ...await original<typeof import('../lib/api')>(), request: vi.fn() }));
const file = (type = 'application/pdf') => { const value = new File(['evidence'], 'signed.pdf', { type }); Object.defineProperty(value, 'arrayBuffer', { value: async () => new ArrayBuffer(8) }); return value; };
describe('measurement API contract', () => {
  beforeEach(() => { vi.mocked(request).mockReset(); vi.mocked(request).mockResolvedValue({}); });
  afterEach(() => vi.unstubAllGlobals());
  it('scopes listing, encodes resource IDs and passes optimistic versions on every workflow mutation', async () => {
    await measurementApi.list(); expect(request).toHaveBeenLastCalledWith('/api/measurement-plans');
    await measurementApi.list('a/b'); expect(request).toHaveBeenLastCalledWith('/api/measurement-plans?callId=a%2Fb');
    await measurementApi.detail('a/b'); expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/a%2Fb');
    await measurementApi.create({ title: 'Survey' } as PlanInput);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans', expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'Survey' }) }));
    await measurementApi.update('plan', { version: 4, title: 'New title' });
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ version: 4, title: 'New title' }) }));
    await measurementApi.submit('plan', 5, { participantId: 'party' } as SubmissionInput);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/submissions', expect.objectContaining({ body: JSON.stringify({ participantId: 'party', version: 5 }) }));
    await measurementApi.propose('plan', 6, { reason: 'Joint survey' } as ReconciliationInput);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/reconciliations', expect.objectContaining({ body: JSON.stringify({ reason: 'Joint survey', version: 6 }) }));
    await measurementApi.acknowledge('plan', 'r/1', 7, { decision: 'agreed' } as ApprovalInput);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/reconciliations/r%2F1/approvals', expect.objectContaining({ body: JSON.stringify({ decision: 'agreed', version: 7 }) }));
    await measurementApi.finalize('plan', 'r/1', 8);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/reconciliations/r%2F1/finalize', expect.objectContaining({ body: JSON.stringify({ version: 8 }) }));
    await measurementApi.assess('plan', 9, { reconciliationId: 'r1' } as AssessmentInput);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/assessments', expect.objectContaining({ body: JSON.stringify({ reconciliationId: 'r1', version: 9 }) }));
    await measurementApi.issue('plan', 'a/1', 10);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/assessments/a%2F1/issue', expect.objectContaining({ body: JSON.stringify({ version: 10 }) }));
    await measurementApi.evidence('plan', 'e/1'); expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/plan/evidence/e%2F1');
    expect(measurementApi.documentUrl('plan', 'r/1')).toBe('/api/measurement-plans/plan/reconciliations/r%2F1/document');
  });
  it('rejects unsupported, empty and oversized evidence before requesting storage access', async () => {
    await expect(measurementApi.upload('p', file('text/plain'))).rejects.toThrow('Choose a PDF');
    await expect(measurementApi.upload('p', new File([], 'empty.pdf', { type: 'application/pdf' }))).rejects.toThrow('between 1 byte and 15 MB');
    const oversized = file(); Object.defineProperty(oversized, 'size', { value: 15 * 1024 * 1024 + 1 });
    await expect(measurementApi.upload('p', oversized)).rejects.toThrow('between 1 byte and 15 MB');
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps link issuance scoped to the chosen plan and agency and encodes receipt identifiers', async () => {
    await measurementApi.agencyLinks('p/1');
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/p%2F1/agency-links');
    await measurementApi.createAgencyLink('p/1', 'a/2', 7);
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/p%2F1/participants/a%2F2/agency-links', { method: 'POST', body: JSON.stringify({ expiryDays: 7 }) });
    await measurementApi.revokeAgencyLink('p/1', 'l/3');
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/p%2F1/agency-links/l%2F3/revoke', { method: 'POST', body: '{}' });
    expect(measurementApi.submissionDocumentUrl('p/1', 's/4')).toBe('/api/measurement-plans/p%2F1/submissions/s%2F4/receipt');
  });
  it('hashes and uploads evidence before registering the immutable file', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array([1, 255]).buffer) } });
    vi.mocked(request).mockResolvedValueOnce({ uploadUrl: 'https://storage.example/upload', headers: { 'Content-Type': 'application/pdf' }, objectKey: 'private/e1' }).mockResolvedValueOnce({ evidence: { id: 'e1' } });
    const source = file();
    await expect(measurementApi.upload('p', source)).resolves.toEqual({ id: 'e1' });
    expect(fetch).toHaveBeenCalledWith('https://storage.example/upload', { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: source });
    expect(request).toHaveBeenLastCalledWith('/api/measurement-plans/p/evidence', { method: 'POST', body: JSON.stringify({ fileName: 'signed.pdf', contentType: 'application/pdf', size: 8, checksum: 'sha256:01ff', objectKey: 'private/e1' }) });
  });
  it('does not register evidence when storage rejects the upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockResolvedValue(new ArrayBuffer(0)) } });
    vi.mocked(request).mockResolvedValueOnce({ uploadUrl: 'https://storage.example/upload', objectKey: 'private/e1' });
    await expect(measurementApi.upload('p', file())).rejects.toBeInstanceOf(ApiError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
