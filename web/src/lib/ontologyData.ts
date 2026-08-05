import { supabase } from "./supabaseClient";
import { NewsItem, Outlook, OntologyEdge, OntologyNode } from "./types";

// Supabase(Postgres)의 snake_case 컬럼을 그대로 옮긴 행 타입.
interface NodeRow {
  id: string;
  type: OntologyNode["type"];
  name: string;
  ticker: string | null;
  price: number | null;
  change_percent: number | null;
  company_summary: string | null;
  ceo: string | null;
  market_cap: string | null;
  logo: string | null;
  news: NewsItem[] | null;
  outlook: Outlook | null;
  category: NonNullable<OntologyNode["category"]> | null;
  description: string | null;
}

interface EdgeRow {
  id: string;
  source: string;
  target: string;
  type: OntologyEdge["type"];
  direction: OntologyEdge["direction"];
  polarity: NonNullable<OntologyEdge["polarity"]> | null;
  strength: number | null;
  confidence: number | null;
  rationale: string | null;
}

function toNode(row: NodeRow): OntologyNode {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    ticker: row.ticker ?? undefined,
    price: row.price ?? undefined,
    changePercent: row.change_percent ?? undefined,
    companySummary: row.company_summary ?? undefined,
    ceo: row.ceo ?? undefined,
    marketCap: row.market_cap ?? undefined,
    logo: row.logo ?? undefined,
    news: row.news && row.news.length > 0 ? row.news : undefined,
    outlook: row.outlook ?? undefined,
    category: row.category ?? undefined,
    description: row.description ?? undefined,
  };
}

function toEdge(row: EdgeRow): OntologyEdge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    type: row.type,
    direction: row.direction,
    polarity: row.polarity ?? undefined,
    strength: row.strength ?? undefined,
    confidence: row.confidence ?? undefined,
    rationale: row.rationale ?? undefined,
  };
}

// 1단계 규모(노드 수십~수백 개)에서는 매번 전체를 한 번에 가져와도 충분히 빠르다.
// 데이터가 훨씬 커지면 그때 1-hop 단위 조회로 바꾸면 된다.
export async function fetchOntology(): Promise<{ nodes: OntologyNode[]; edges: OntologyEdge[] }> {
  const [nodesResult, edgesResult] = await Promise.all([
    supabase.from("nodes").select("*").returns<NodeRow[]>(),
    supabase.from("edges").select("*").returns<EdgeRow[]>(),
  ]);

  if (nodesResult.error) throw nodesResult.error;
  if (edgesResult.error) throw edgesResult.error;

  return {
    nodes: nodesResult.data.map(toNode),
    edges: edgesResult.data.map(toEdge),
  };
}
