export type NodeType = "Sector" | "Industry" | "Asset" | "Concept";

export type EdgeType = "BELONGS_TO" | "COMPETES_WITH" | "AFFECTS";

export type Polarity = "positive" | "negative" | "mixed";

export interface NewsItem {
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  source: string;
  sentiment: "positive" | "neutral" | "negative";
}

export interface Outlook {
  summary: string;
  riskFactors: string[];
  generatedAt: string;
}

export interface OntologyNode {
  id: string;
  type: NodeType;
  name: string;
  // Asset 노드에만 해당하는 상세 정보 (목업). 실제로는 4장 상세 패널 스펙을 따른다.
  ticker?: string;
  price?: number;
  changePercent?: number;
  companySummary?: string;
  ceo?: string;
  marketCap?: string;
  logo?: string;
  news?: NewsItem[];
  outlook?: Outlook;
  // Concept 노드 카테고리
  category?: "거시" | "기술" | "정책" | "지정학";
  description?: string;
}

export interface OntologyEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  direction: "단방향" | "양방향";
  polarity?: Polarity;
  strength?: number; // 1~5
  confidence?: number; // 0~1
  rationale?: string;
}
