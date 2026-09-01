import { describe, expect, it } from 'vitest';
import { DESIGN_TOOL_NAMES } from '@specbridge/mcp-server';

describe('MCP product boundary', () => {
  it('exposes only bounded design and Spec Pack operations', () => {
    expect(DESIGN_TOOL_NAMES).toEqual([
      'workspace_detect',
      'workspace_bootstrap',
      'design_start',
      'design_read',
      'design_answer',
      'design_research',
      'design_generate',
      'design_evaluate',
      'design_approve',
      'spec_list',
      'spec_read',
    ]);
    const surface = DESIGN_TOOL_NAMES.join(' ');
    for (const forbidden of [
      'job',
      'mission',
      'workunit',
      'attempt',
      'runner',
      'worker',
      'handoff',
      'resume',
      'build',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});
