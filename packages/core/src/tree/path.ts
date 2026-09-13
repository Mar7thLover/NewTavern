/**
 * 消息树操作：root→head 路径线性化、兄弟排序。
 * 无后代的兄弟即 swipe，有后代即分支。见 docs/PLAN.md §3.3 message_nodes。
 */

export interface TreeNode {
  id: string;
  parentId: string | null;
  /** 兄弟节点间的顺序（同一 parent 内递增） */
  siblingSeq: number;
}

/**
 * 返回从 root 到 head 的路径（含两端，按对话顺序排列）。
 * @throws 节点缺失或检测到环
 */
export function linearizePath<N extends TreeNode>(
  nodes: ReadonlyMap<string, N>,
  headId: string,
): N[] {
  const path: N[] = [];
  const seen = new Set<string>();
  let cursor: string | null = headId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new Error(`消息树存在环：${cursor}`);
    }
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (!node) {
      throw new Error(`消息节点不存在：${cursor}`);
    }
    path.push(node);
    cursor = node.parentId;
  }
  return path.reverse();
}

/** 某节点的全部子节点，按 siblingSeq 排序 */
export function childrenOf<N extends TreeNode>(nodes: Iterable<N>, parentId: string | null): N[] {
  const children: N[] = [];
  for (const node of nodes) {
    if (node.parentId === parentId) children.push(node);
  }
  return children.sort((a, b) => a.siblingSeq - b.siblingSeq);
}

/** 无后代的兄弟节点集合 = swipe 组 */
export function isSwipeGroup<N extends TreeNode>(
  nodes: Iterable<N>,
  siblings: readonly N[],
): boolean {
  return siblings.every((node) => childrenOf(nodes, node.id).length === 0);
}
