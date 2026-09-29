import type { MeasurementPlan, Reconciliation } from './types';
export const measurementFixture = (): MeasurementPlan => ({
  id: 'plan-1', callId: 'call-1', callReference: 'CALL-001', vesselName: 'MV Atlas', version: 4,
  title: 'Discharge survey', status: 'in-progress', scheduledAt: '2026-09-29T10:00:00Z', endsAt: null,
  location: 'Berth 2', method: 'Draft survey', stage: 'After discharge', scope: 'Parcel A', leadSurveyor: 'Ada', notes: '', createdBy: { id: 'ops-1', name: 'Ada Operations' },
  participants: [ { id: 'party-1', name: 'Harbour Agent', role: 'Agent', representative: 'Grace', requiredSubmission: true, requiredApproval: true }, { id: 'party-2', name: 'Terminal One', role: 'Terminal operator', representative: 'Tunde', requiredSubmission: true, requiredApproval: true } ],
  lines: [{ id: 'line-1', description: 'Wheat', category: 'Bulk', direction: 'import', containerSize: '', loadStatus: '', unit: 'tonnes', basis: 'Net metric tonnes', manifestQuantity: '19500.000', baselineReference: 'BL-001' }],
  evidence: [{ id: 'file-1', fileName: 'signed-survey.pdf', contentType: 'application/pdf', size: 3000, checksum: 'sha256:abcd', createdAt: '2026-09-29T10:00:00Z' }],
  submissions: [{ id: 'sub-1', participantId: 'party-1', revision: 1, observedAt: '2026-09-29T10:00:00Z', sourceReference: 'AGENT-001', notes: '', reason: '', lines: [{ lineId: 'line-1', status: 'reported', quantity: '19508.000', note: '' }], evidenceIds: ['file-1'], recordedBy: { id: 'ops-1', name: 'Ada Operations' }, recordedAt: '2026-09-29T10:00:00Z' }],
  reconciliations: [], assessments: [],
});
export const reconciliationFixture = (): Reconciliation => ({
  id: 'recon-1', revision: 1, status: 'draft', createdBy: { id: 'ops-1', name: 'Ada Operations' }, createdAt: '2026-09-29T11:00:00Z', finalizedBy: null, finalizedAt: null, reason: 'Verified against survey', lines: [{ lineId: 'line-1', quantity: '19508.000', manifestQuantity: '19500.000', variance: '8.000', reason: 'Joint draft survey confirmed' }], submissionIds: ['sub-1'], evidenceIds: [], approvals: [],
});
export const assessmentFixture = (): import('./types').Assessment => ({
  id: 'assessment-1', reconciliationId: 'recon-1', payer: 'Harbour Agent', currency: 'USD', policy: 'manifest-disparity', tariffReference: 'TARIFF-2026', reason: 'Approved excess charge', openingChargesReference: 'No prior cargo charges', status: 'ready', total: '80.00', invoiceId: null, createdAt: '2026-09-29T12:00:00Z',
  lines: [{ lineId: 'line-1', description: 'Wheat', unit: 'tonnes', baselineQuantity: '19500.000', finalQuantity: '19508.000', variance: '8.000', rate: '10.0000', tolerance: '0.000', toleranceMode: 'threshold', previouslyBilledQuantity: null, chargeableQuantity: '8.000', entitlement: '80.00', openingBilledAmount: '0.00', priorInvoicedAmount: '0.00', amount: '80.00' }],
});
