import { describe, expect, it } from 'vitest';
import { cargoInputLabel, cargoLabelForId, cargoScopeLabel } from './helpers';
import { measurementFixture } from './fixtures.test-support';

describe('cargo scope labels', () => {
  it('keeps a unique bulk description unchanged', () => {
    const lines = measurementFixture().lines;
    expect(cargoInputLabel(lines[0], lines)).toBe('Wheat');
  });
  it('identifies container direction, size and load status even for a single cargo line', () => {
    const line = { ...measurementFixture().lines[0], description: 'Containers', containerSize: '45', loadStatus: 'empty', direction: 'export' };
    expect(cargoInputLabel(line, [line])).toBe('Containers · export · 45 ft · empty');
  });
  it('distinguishes repeated bulk descriptions by operation direction', () => {
    const first = measurementFixture().lines[0]; const second = { ...first, id: 'line-2', direction: 'export' };
    expect(cargoInputLabel(first, [first, second])).toBe('Wheat · import');
    expect(cargoInputLabel(second, [first, second])).toBe('Wheat · export');
  });
  it('uses cargo line position when all visible scope attributes repeat', () => {
    const first = measurementFixture().lines[0]; const second = { ...first, id: 'line-2', basis: 'Gross weight' };
    expect(cargoInputLabel(first, [first, second])).toBe('Wheat · import · line 1');
    expect(cargoInputLabel(second, [first, second])).toBe('Wheat · import · line 2');
  });
  it('handles legacy assessment lines without optional scope fields and unknown history references', () => {
    expect(cargoScopeLabel({ description: 'Wheat' })).toBe('');
    expect(cargoLabelForId(measurementFixture().lines, 'line-1')).toBe('Wheat');
    expect(cargoLabelForId(measurementFixture().lines, 'missing')).toBe('Cargo line');
  });
});
