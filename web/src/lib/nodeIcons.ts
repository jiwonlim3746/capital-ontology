import { NodeType, OntologyNode } from "./types";

// Material Symbols Outlined ligature 이름. 스펙 3.4절 표와 반드시 동기화할 것.
const NODE_ICON_BY_ID: Record<string, string> = {
  "sector-tech": "memory",
  "sector-energy": "bolt",
  "industry-semi": "developer_board",
  "industry-software": "code",
  "industry-oilgas": "oil_barrel",
  "concept-rates": "percent",
  "concept-inflation": "trending_up",
  "concept-quantum": "science",
  "concept-ai-demand": "smart_toy",
};

// 매핑에 없는 노드(향후 추가될 종목·개념 등)를 위한 타입별 기본 아이콘.
const NODE_ICON_FALLBACK_BY_TYPE: Partial<Record<NodeType, string>> = {
  Sector: "category",
  Industry: "factory",
  Concept: "lightbulb",
};

// Asset 타입은 아이콘을 쓰지 않는다 (호출부에서 티커 앞 두 글자를 그린다).
export function getNodeIcon(node: Pick<OntologyNode, "id" | "type">): string | null {
  if (node.type === "Asset") return null;
  return NODE_ICON_BY_ID[node.id] ?? NODE_ICON_FALLBACK_BY_TYPE[node.type] ?? null;
}
