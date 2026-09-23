import { describe, expect, it } from 'vitest';

import { isSquashableSegment, type Part, type Segment } from './ir.js';

function system(parts: Part[], ref?: string): Segment {
  return {
    id: 's',
    role: 'system',
    parts,
    origin: { kind: 'preset', ...(ref ? { ref } : {}) },
    anchor: { slot: 'system', order: 0 },
    stability: 'static',
  };
}

describe('isSquashableSegment', () => {
  it('单文本 system 段可合并；分隔段、带 name、多 part 不合并', () => {
    expect(isSquashableSegment(system([{ type: 'text', text: 'a' }]))).toBe(true);
    expect(isSquashableSegment(system([{ type: 'text', text: 'a' }], 'new_chat_prompt'))).toBe(
      false,
    );
    expect(isSquashableSegment({ ...system([{ type: 'text', text: 'a' }]), name: 'n' })).toBe(
      false,
    );
    expect(
      isSquashableSegment(
        system([
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ]),
      ),
    ).toBe(false);
  });

  it('含 tool_call / tool_result 的段不合并（M6 契约 §1.1）', () => {
    expect(
      isSquashableSegment(system([{ type: 'tool_call', id: 'c', name: 'f', args: '{}' }])),
    ).toBe(false);
    expect(
      isSquashableSegment(system([{ type: 'tool_result', callId: 'c', name: 'f', content: 'ok' }])),
    ).toBe(false);
  });
});
