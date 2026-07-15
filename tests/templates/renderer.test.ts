import { describe, expect, it } from 'vitest';
import {
  TemplateError,
  collectPlaceholders,
  parseTemplateManifest,
  renderTemplateText,
  resolveVariables,
} from '@specbridge/templates';
import { fixedClock } from '../helpers';
import { featureManifest } from '../helpers-templates';

const BUILTINS = {
  specName: 'my-spec',
  title: 'My Spec',
  description: 'A description.',
  kind: 'feature',
  mode: 'requirements-first',
  clock: fixedClock,
};

function manifestWith(variables: unknown[]): ReturnType<typeof parseTemplateManifest>['manifest'] {
  const parsed = parseTemplateManifest(JSON.stringify(featureManifest({ variables })));
  if (parsed.manifest === undefined) throw new Error('test manifest invalid');
  return parsed.manifest;
}

describe('restricted renderer', () => {
  it('substitutes string variables', () => {
    const values = new Map([['title', 'Payments']]);
    expect(renderTemplateText('t', 'Hello {{title}}!', values)).toBe('Hello Payments!');
  });

  it('renders boolean and integer values as plain text', () => {
    const manifest = manifestWith([
      { name: 'enabled', description: 'flag', type: 'boolean', required: false, default: true },
      { name: 'retries', description: 'count', type: 'integer', required: false, default: 3 },
    ]);
    const resolved = resolveVariables(manifest!, {}, BUILTINS);
    expect(renderTemplateText('t', '{{enabled}} / {{retries}}', resolved.values)).toBe('true / 3');
  });

  it('validates enum values', () => {
    const manifest = manifestWith([
      { name: 'level', description: 'level', type: 'enum', required: true, values: ['low', 'high'] },
    ]);
    expect(resolveVariables(manifest!, { level: 'low' }, BUILTINS).values.get('level')).toBe('low');
    expect(() => resolveVariables(manifest!, { level: 'medium' }, BUILTINS)).toThrowError(/SBT015/);
  });

  it('fails on a missing required variable with SBT013', () => {
    const manifest = manifestWith([{ name: 'tableName', description: 'table', type: 'string', required: true }]);
    expect(() => resolveVariables(manifest!, {}, BUILTINS)).toThrowError(/SBT013/);
  });

  it('applies defaults deterministically', () => {
    const manifest = manifestWith([
      { name: 'actor', description: 'actor', type: 'string', required: false, default: 'user' },
    ]);
    expect(resolveVariables(manifest!, {}, BUILTINS).values.get('actor')).toBe('user');
  });

  it('treats an explicit empty string as a value, distinct from missing', () => {
    const manifest = manifestWith([
      { name: 'note', description: 'note', type: 'string', required: false, default: 'fallback' },
    ]);
    expect(resolveVariables(manifest!, { note: '' }, BUILTINS).values.get('note')).toBe('');
    expect(resolveVariables(manifest!, {}, BUILTINS).values.get('note')).toBe('fallback');
  });

  it('fails on an unknown supplied variable with SBT014', () => {
    const manifest = manifestWith([]);
    expect(() => resolveVariables(manifest!, { mystery: 'x' }, BUILTINS)).toThrowError(/SBT014/);
  });

  it('refuses supplied built-in variables', () => {
    const manifest = manifestWith([]);
    expect(() => resolveVariables(manifest!, { specName: 'hijack' }, BUILTINS)).toThrowError(/SBT014/);
  });

  it('rejects null bytes in values with SBT015', () => {
    const manifest = manifestWith([{ name: 'actor', description: 'actor', type: 'string', required: false }]);
    expect(() => resolveVariables(manifest!, { actor: 'a\0b' }, BUILTINS)).toThrowError(/SBT015/);
  });

  it('preserves UTF-8 values', () => {
    const manifest = manifestWith([{ name: 'actor', description: 'actor', type: 'string', required: false }]);
    const resolved = resolveVariables(manifest!, { actor: 'ユーザー — обычный 🚀' }, BUILTINS);
    expect(renderTemplateText('t', 'Actor: {{actor}}', resolved.values)).toBe('Actor: ユーザー — обычный 🚀');
  });

  it('enforces one-pass rendering: values containing placeholders stay literal', () => {
    const values = new Map([
      ['title', '{{dangerous}}'],
      ['dangerous', 'EXPLOITED'],
    ]);
    expect(renderTemplateText('t', 'X {{title}} Y', values)).toBe('X {{dangerous}} Y');
  });

  it('does not recursively render nested variable content', () => {
    const values = new Map([['a', '{{b}}'], ['b', '{{c}}'], ['c', 'deep']]);
    expect(renderTemplateText('t', '{{a}}', values)).toBe('{{b}}');
  });

  it('does not support expressions', () => {
    const values = new Map([['title', 'x']]);
    expect(() => renderTemplateText('t', '{{title.toUpperCase()}}', values)).toThrowError(/SBT016/);
    expect(() => renderTemplateText('t', '{{ title }}', values)).toThrowError(/SBT016/);
    expect(() => renderTemplateText('t', '{{constructor}}', values)).toThrowError(/SBT016/);
    expect(() => renderTemplateText('t', '{{__proto__}}', values)).toThrowError(/SBT016/);
  });

  it('cannot read environment variables', () => {
    process.env['TEMPLATE_SECRET_PROBE'] = 'leaked';
    try {
      const values = new Map([['title', 'x']]);
      expect(() => renderTemplateText('t', '{{TEMPLATE_SECRET_PROBE}}', values)).toThrowError(/SBT016/);
      expect(() => renderTemplateText('t', '{{env.TEMPLATE_SECRET_PROBE}}', values)).toThrowError(/SBT016/);
      const rendered = renderTemplateText('t', 'safe {{title}}', values);
      expect(rendered).not.toContain('leaked');
    } finally {
      delete process.env['TEMPLATE_SECRET_PROBE'];
    }
  });

  it('fails on unresolved placeholders with SBT016', () => {
    const values = new Map([['title', 'x']]);
    expect(() => renderTemplateText('t', '{{missing}}', values)).toThrowError(TemplateError);
    expect(() => renderTemplateText('t', '{{missing}}', values)).toThrowError(/SBT016/);
  });

  it('enforces the rendered output size limit with SBT018', () => {
    const values = new Map([['big', 'x'.repeat(600_000)]]);
    expect(() => renderTemplateText('t', '{{big}}{{big}}', values)).toThrowError(/SBT018/);
  });

  it('renders deterministically', () => {
    const values = new Map([['title', 'Same']]);
    const a = renderTemplateText('t', '# {{title}}\n\nBody.\n', values);
    const b = renderTemplateText('t', '# {{title}}\n\nBody.\n', values);
    expect(a).toBe(b);
  });

  it('provides generatedDate only when the manifest opts in, from the injected clock', () => {
    const optIn = parseTemplateManifest(
      JSON.stringify(featureManifest({ generatedDate: true })),
    ).manifest;
    const resolved = resolveVariables(optIn!, {}, BUILTINS);
    expect(resolved.values.get('generatedDate')).toBe('2026-07-12');

    const noOptIn = manifestWith([]);
    expect(resolveVariables(noOptIn!, {}, BUILTINS).values.has('generatedDate')).toBe(false);
  });

  it('collects placeholders and flags malformed ones', () => {
    const { names, malformed } = collectPlaceholders('{{title}} {{bad name}} {{title}} {{other}}');
    expect(names).toEqual(['title', 'other']);
    expect(malformed).toHaveLength(1);
  });

  it('validates integer bounds and string length constraints', () => {
    const manifest = manifestWith([
      { name: 'count', description: 'count', type: 'integer', required: true, minimum: 1, maximum: 10 },
      { name: 'label', description: 'label', type: 'string', required: false, minLength: 2, maxLength: 4 },
    ]);
    expect(resolveVariables(manifest!, { count: '5' }, BUILTINS).values.get('count')).toBe('5');
    expect(() => resolveVariables(manifest!, { count: '0' }, BUILTINS)).toThrowError(/SBT015/);
    expect(() => resolveVariables(manifest!, { count: '11' }, BUILTINS)).toThrowError(/SBT015/);
    expect(() => resolveVariables(manifest!, { count: 'ten' }, BUILTINS)).toThrowError(/SBT015/);
    expect(() => resolveVariables(manifest!, { count: '5', label: 'x' }, BUILTINS)).toThrowError(/SBT015/);
    expect(() => resolveVariables(manifest!, { count: '5', label: 'xxxxx' }, BUILTINS)).toThrowError(/SBT015/);
  });
});
