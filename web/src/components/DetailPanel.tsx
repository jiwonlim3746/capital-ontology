"use client";

import { getConnectedEdges } from "@/lib/graph";
import { OntologyEdge, OntologyNode } from "@/lib/types";

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "긍정",
  neutral: "중립",
  negative: "부정",
};

const POLARITY_LABEL: Record<string, string> = {
  positive: "긍정적",
  negative: "부정적",
  mixed: "혼재",
};

interface DetailPanelProps {
  node: OntologyNode | null;
  edges: OntologyEdge[];
  nodeById: Map<string, OntologyNode>;
  onJumpToNode: (id: string) => void;
  onClose: () => void;
}

export default function DetailPanel({ node, edges, nodeById, onJumpToNode, onClose }: DetailPanelProps) {
  if (!node) {
    return (
      <aside className="w-80 shrink-0 border-l border-black/10 p-4 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
        노드를 클릭하면 여기에 상세 정보가 표시됩니다.
      </aside>
    );
  }

  const relations = getConnectedEdges(edges, node.id)
    .map((edge) => {
      const otherId = edge.source === node.id ? edge.target : edge.source;
      const other = nodeById.get(otherId);
      return other ? { edge, other } : null;
    })
    .filter((r): r is { edge: OntologyEdge; other: OntologyNode } => r !== null);

  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-black/10 p-4 text-sm dark:border-white/10">
      <button onClick={onClose} className="mb-3 text-xs text-zinc-500 hover:underline dark:text-zinc-400">
        닫기
      </button>

      {/* 헤더 */}
      <header className="mb-4">
        <h2 className="text-lg font-semibold">{node.name}</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {node.type === "Asset" && node.ticker ? `${node.ticker} · ` : ""}
          {node.type}
          {node.category ? ` · ${node.category}` : ""}
        </p>
      </header>

      {node.type === "Asset" && (
        <>
          {/* 주가 정보 */}
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">주가 정보</h3>
            <p className="text-base font-medium">
              ${node.price?.toFixed(2)}{" "}
              <span className={node.changePercent && node.changePercent >= 0 ? "text-green-600" : "text-red-600"}>
                {node.changePercent && node.changePercent >= 0 ? "+" : ""}
                {node.changePercent}%
              </span>
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">(예시 데이터 — 실제 시세 아님)</p>
          </section>

          {/* 기업 개요 */}
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">기업 개요</h3>
            <p className="mb-1">{node.companySummary}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              CEO: {node.ceo} · 시가총액: {node.marketCap}
            </p>
          </section>

          {/* AI 전망 */}
          {node.outlook && (
            <section className="mb-4">
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                AI 전망 요약
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900 dark:text-violet-200">
                  AI 생성
                </span>
              </h3>
              <p className="mb-1">{node.outlook.summary}</p>
              {node.outlook.riskFactors.length > 0 && (
                <ul className="mb-1 list-inside list-disc text-xs text-zinc-600 dark:text-zinc-300">
                  {node.outlook.riskFactors.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-zinc-400">
                생성 시각: {new Date(node.outlook.generatedAt).toLocaleString("ko-KR")} · 투자 조언이 아닙니다.
              </p>
            </section>
          )}

          {/* 최근 뉴스 */}
          {node.news && node.news.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">최근 뉴스</h3>
              <ul className="space-y-2">
                {node.news.map((n) => (
                  <li key={n.url} className="border-b border-black/5 pb-2 last:border-none dark:border-white/5">
                    <a href={n.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                      {n.title}
                    </a>
                    <p className="text-xs text-zinc-600 dark:text-zinc-300">{n.summary}</p>
                    <p className="text-[10px] text-zinc-400">
                      {n.publishedAt} · {n.source} ·{" "}
                      <span
                        className={
                          n.sentiment === "positive"
                            ? "text-green-600"
                            : n.sentiment === "negative"
                              ? "text-red-600"
                              : "text-zinc-500"
                        }
                      >
                        {SENTIMENT_LABEL[n.sentiment]}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {node.type === "Concept" && node.description && (
        <section className="mb-4">
          <p>{node.description}</p>
        </section>
      )}

      {/* 연결된 관계 */}
      {relations.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">연결된 관계</h3>
          <ul className="space-y-2">
            {relations.map(({ edge, other }) => (
              <li key={edge.id}>
                <button
                  onClick={() => onJumpToNode(other.id)}
                  className="font-medium text-left hover:underline"
                >
                  {other.name}
                </button>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {edge.type}
                  {edge.polarity ? ` · ${POLARITY_LABEL[edge.polarity]}` : ""}
                  {edge.confidence !== undefined ? ` · 신뢰도 ${Math.round(edge.confidence * 100)}%` : ""}
                </p>
                {edge.rationale && <p className="text-xs text-zinc-600 dark:text-zinc-300">{edge.rationale}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
