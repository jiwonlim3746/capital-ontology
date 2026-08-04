"use client";

import { useEffect, useMemo, useState } from "react";
import GraphView from "@/components/GraphView";
import DetailPanel from "@/components/DetailPanel";
import { computeAncestorChain } from "@/lib/graph";
import { fetchOntology } from "@/lib/ontologyData";
import { OntologyEdge, OntologyNode } from "@/lib/types";

export default function Home() {
  const [nodes, setNodes] = useState<OntologyNode[]>([]);
  const [edges, setEdges] = useState<OntologyEdge[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "error" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    fetchOntology()
      .then(({ nodes, edges }) => {
        setNodes(nodes);
        setEdges(edges);
        setLoadState("ready");
      })
      .catch((err) => {
        // Supabase의 PostgrestError는 Error의 인스턴스가 아니라 { message } 형태의 일반 객체라서
        // err instanceof Error만으로는 못 걸러내고 "[object Object]"로 표시돼버린다.
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err);
        setErrorMessage(message);
        setLoadState("error");
      });
  }, []);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const jumpToNode = (id: string) => {
    setExpandedIds((prev) => new Set([...prev, ...computeAncestorChain(edges, id)]));
    setSelectedNodeId(id);
  };

  const selectedNode = selectedNodeId ? (nodeById.get(selectedNodeId) ?? null) : null;

  if (loadState === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        데이터 불러오는 중…
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-red-600 dark:text-red-400">
        데이터를 불러오지 못했습니다: {errorMessage}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <main className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute left-4 top-4 z-10 text-xs text-zinc-500 dark:text-zinc-400">
          섹터·산업 노드를 클릭하면 하위 노드가 펼쳐집니다. 종목을 클릭하면 오른쪽에 상세 정보가 뜹니다.
        </div>
        <GraphView
          nodes={nodes}
          edges={edges}
          expandedIds={expandedIds}
          selectedNodeId={selectedNodeId}
          onToggleExpand={toggleExpand}
          onSelectNode={setSelectedNodeId}
          onBackgroundClick={() => setSelectedNodeId(null)}
        />
      </main>
      <DetailPanel
        node={selectedNode}
        edges={edges}
        nodeById={nodeById}
        onJumpToNode={jumpToNode}
        onClose={() => setSelectedNodeId(null)}
      />
    </div>
  );
}
