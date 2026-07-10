import { describe, expect, it } from 'vitest';
import {
  createJsonReport,
  escapeHtml,
  renderColumns,
  renderHtmlReport,
  serializeJsonReport,
} from '@specbridge/reporting';

describe('json report envelope', () => {
  it('is deterministic and newline-terminated', () => {
    const report = createJsonReport('specbridge.test/1', 'specbridge 0.1.0', { a: 1 });
    const text = serializeJsonReport(report);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      schema: 'specbridge.test/1',
      generator: 'specbridge 0.1.0',
      data: { a: 1 },
    });
  });
});

describe('html report', () => {
  it('renders a self-contained document with no external references', () => {
    const html = renderHtmlReport({
      title: 'Spec Drift Report',
      subtitle: 'example',
      sections: [
        {
          heading: 'Tasks',
          items: [
            { status: 'ok', text: '6 verified' },
            { status: 'fail', text: '1 marked complete without evidence', detail: 'task 3' },
          ],
        },
      ],
      footer: 'generated offline',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Spec Drift Report');
    expect(html).toContain('1 marked complete without evidence');
    // Self-contained: no scripts, no external URLs.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('escapes untrusted content', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    const html = renderHtmlReport({
      title: '<script>alert(1)</script>',
      sections: [{ heading: 'H', items: [{ status: 'info', text: '<b>bold?</b>' }] }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;bold?&lt;/b&gt;');
  });
});

describe('terminal columns', () => {
  it('aligns columns and trims trailing whitespace', () => {
    const lines = renderColumns([
      ['a', 'long-value', 'x'],
      ['longer', 'b', 'y'],
    ]);
    expect(lines).toEqual(['  a       long-value  x', '  longer  b           y']);
    expect(lines.every((line) => line === line.replace(/\s+$/, ''))).toBe(true);
  });
});
