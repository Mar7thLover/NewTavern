import { describe, expect, it } from 'vitest';

import { childrenOf, isSwipeGroup, linearizePath, type TreeNode } from './path.js';

function node(id: string, parentId: string | null, siblingSeq = 0): TreeNode {
  return { id, parentId, siblingSeq };
}

const tree = new Map<string, TreeNode>(
  [
    node('a', null),
    node('b', 'a'),
    node('c', 'b'),
    node('d', 'c'),
    node('c2', 'b', 1),
    node('e', 'd'),
  ].map((n) => [n.id, n]),
);

describe('linearizePath', () => {
  it('返回 root→head 的有序路径', () => {
    expect(linearizePath(tree, 'd').map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(linearizePath(tree, 'e').map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('支持分支 head', () => {
    expect(linearizePath(tree, 'c2').map((n) => n.id)).toEqual(['a', 'b', 'c2']);
  });

  it('节点缺失时报错', () => {
    expect(() => linearizePath(tree, 'missing')).toThrow('消息节点不存在');
  });

  it('检测环', () => {
    const cyclic = new Map<string, TreeNode>([
      ['x', node('x', 'y')],
      ['y', node('y', 'x')],
    ]);
    expect(() => linearizePath(cyclic, 'x')).toThrow('环');
  });
});

describe('childrenOf / isSwipeGroup', () => {
  it('按 siblingSeq 排序子节点', () => {
    expect(childrenOf(tree.values(), 'b').map((n) => n.id)).toEqual(['c', 'c2']);
  });

  it('无后代的兄弟组是 swipe', () => {
    expect(isSwipeGroup(tree.values(), [tree.get('c2')!])).toBe(true);
    expect(isSwipeGroup(tree.values(), [tree.get('c')!, tree.get('c2')!])).toBe(false);
  });
});
