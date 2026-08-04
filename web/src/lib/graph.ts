import { OntologyEdge, OntologyNode } from "./types";

// Sector/Concept 노드는 항상 보이고, Industry는 부모 Sector가,
// Asset은 부모 Industry가 expandedIds에 있어야 보인다 (스펙의 "한 번에 다 보여주지 않는다" 원칙).

export function getBelongsToParentId(edges: OntologyEdge[], nodeId: string): string | undefined {
  return edges.find((e) => e.type === "BELONGS_TO" && e.source === nodeId)?.target;
}

export function computeVisibleNodeIds(
  nodes: OntologyNode[],
  edges: OntologyEdge[],
  expandedIds: Set<string>
): Set<string> {
  const visible = new Set<string>();
  for (const node of nodes) {
    if (node.type === "Sector" || node.type === "Concept") {
      visible.add(node.id);
      continue;
    }
    const parentId = getBelongsToParentId(edges, node.id);
    if (parentId && expandedIds.has(parentId)) {
      visible.add(node.id);
    }
  }
  return visible;
}

export function computeVisibleGraphData(
  nodes: OntologyNode[],
  edges: OntologyEdge[],
  expandedIds: Set<string>
): {
  nodes: OntologyNode[];
  links: OntologyEdge[];
} {
  const visibleIds = computeVisibleNodeIds(nodes, edges, expandedIds);
  const visibleNodes = nodes.filter((n) => visibleIds.has(n.id));
  // force-graph(d3-force)가 link.source/target을 노드 객체 참조로 바꿔버리므로(mutate),
  // 원본 edges 배열이 오염되지 않도록 매번 얕은 복사본을 넘긴다.
  const links = edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)).map((e) => ({ ...e }));
  return { nodes: visibleNodes, links };
}

// 부모를 순서대로 반환 (가까운 부모 -> 먼 부모). 이 id들을 전부 expandedIds에 넣으면 nodeId가 보이게 된다.
export function computeAncestorChain(edges: OntologyEdge[], nodeId: string): string[] {
  const chain: string[] = [];
  let current = nodeId;
  for (let i = 0; i < 10; i++) {
    const parent = getBelongsToParentId(edges, current);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

export function getConnectedEdges(edges: OntologyEdge[], nodeId: string): OntologyEdge[] {
  return edges.filter((e) => e.source === nodeId || e.target === nodeId);
}

export function getConnectedNodeIds(edges: OntologyEdge[], nodeId: string): Set<string> {
  const ids = new Set<string>();
  for (const e of getConnectedEdges(edges, nodeId)) {
    ids.add(e.source === nodeId ? e.target : e.source);
  }
  return ids;
}
