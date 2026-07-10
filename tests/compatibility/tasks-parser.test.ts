import { describe, expect, it } from 'vitest';
import { MarkdownDocument, findTask, nextOpenTasks, parseTasks } from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

describe('tasks parser', () => {
  it('parses numbered, nested tasks with states and requirement refs', () => {
    const doc = MarkdownDocument.load(
      fixturePath('standard-feature', '.kiro', 'specs', 'user-authentication', 'tasks.md'),
    );
    const model = parseTasks(doc);

    expect(model.allTasks).toHaveLength(10);
    expect(model.tasks.map((t) => t.number)).toEqual(['1', '2', '3', '4']);

    const task2 = findTask(model, '2')!;
    expect(task2.children.map((c) => c.number)).toEqual(['2.1', '2.2', '2.3']);
    expect(task2.state).toBe('done');

    const task21 = findTask(model, '2.1')!;
    expect(task21.state).toBe('done');
    expect(task21.requirementRefs).toEqual(['1.1', '1.2']);

    const task31 = findTask(model, '3.1')!;
    expect(task31.requirementRefs).toEqual(['1.1', '2.2']);

    const task4 = findTask(model, '4')!;
    expect(task4.optional).toBe(true);

    expect(model.progress).toEqual({
      total: 9,
      completed: 3,
      inProgress: 0,
      optionalTotal: 1,
      optionalCompleted: 0,
    });

    const next = nextOpenTasks(model, 3).map((t) => t.number);
    expect(next).toEqual(['2.2', '2.3', '3.1']);
  });

  it('tolerates hand-edited files: flat numbering, odd bullets, in-progress and malformed checkboxes', () => {
    const doc = MarkdownDocument.load(
      fixturePath('manually-edited-feature', '.kiro', 'specs', 'search-filters', 'tasks.md'),
    );
    const model = parseTasks(doc);

    // 5 recognized tasks: 1, 1.1, unnumbered analytics task, 2 (in-progress), 4 (optional)
    expect(model.allTasks).toHaveLength(5);

    const one = findTask(model, '1')!;
    expect(one.state).toBe('done'); // "-   [x] 1." with extra spaces

    const unnumbered = model.allTasks.find((t) => t.number === undefined)!;
    expect(unnumbered.title).toContain('analytics');
    expect(unnumbered.id).toMatch(/^line:\d+$/);

    const two = findTask(model, '2')!;
    expect(two.state).toBe('in-progress');
    expect(two.requirementRefs).toEqual(['1.1']);

    const four = findTask(model, '4')!;
    expect(four.optional).toBe(true); // "(optional)" in the title

    // "- [ x] 3." is malformed: preserved, not counted, and diagnosed.
    expect(findTask(model, '3')).toBeUndefined();
    expect(model.diagnostics.some((d) => d.code === 'TASKS_MALFORMED_CHECKBOX')).toBe(true);

    // The checkbox inside the fenced code block is ignored.
    expect(model.allTasks.some((t) => t.number === '9')).toBe(false);

    expect(model.progress.inProgress).toBe(1);
  });

  it('parses unnumbered task lists', () => {
    const doc = MarkdownDocument.load(
      fixturePath('unknown-headings', '.kiro', 'specs', 'custom-spec', 'tasks.md'),
    );
    const model = parseTasks(doc);
    expect(model.allTasks).toHaveLength(3);
    expect(model.progress).toMatchObject({ total: 3, completed: 1 });
  });

  it('flags duplicate task numbers and empty checkboxes', () => {
    const doc = MarkdownDocument.fromText(
      ['# T', '- [ ] 1. a', '- [ ] 1. duplicate', '- [] empty brackets', ''].join('\n'),
    );
    const model = parseTasks(doc);
    expect(model.diagnostics.some((d) => d.code === 'TASKS_DUPLICATE_NUMBER')).toBe(true);
    expect(model.diagnostics.some((d) => d.code === 'TASKS_MALFORMED_CHECKBOX')).toBe(true);
    expect(model.allTasks).toHaveLength(2);
  });

  it('does not mistake Markdown links for checkboxes', () => {
    const doc = MarkdownDocument.fromText(
      ['- [a link](https://example.com)', '- [ ] 1. real task', ''].join('\n'),
    );
    const model = parseTasks(doc);
    expect(model.allTasks).toHaveLength(1);
    expect(model.diagnostics).toEqual([]);
  });
});
