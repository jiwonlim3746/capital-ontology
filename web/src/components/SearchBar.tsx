"use client";

import { useState } from "react";
import { OntologyNode } from "@/lib/types";

const TYPE_LABEL: Record<OntologyNode["type"], string> = {
  Sector: "섹터",
  Industry: "산업",
  Asset: "종목",
  Concept: "개념",
};

const MAX_RESULTS = 8;

interface SearchBarProps {
  nodes: OntologyNode[];
  onSelect: (id: string) => void;
}

export default function SearchBar({ nodes, onSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? nodes
        .filter((n) => n.name.toLowerCase().includes(trimmed) || (n.ticker?.toLowerCase().includes(trimmed) ?? false))
        .slice(0, MAX_RESULTS)
    : [];

  const handleSelect = (id: string) => {
    onSelect(id);
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div className="relative w-64">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results.length > 0) {
            handleSelect(results[0].id);
          } else if (e.key === "Escape") {
            setIsOpen(false);
          }
        }}
        placeholder="종목·개념 검색…"
        className="w-full rounded border border-black/10 bg-white px-3 py-1.5 text-sm outline-none focus:border-black/30 dark:border-white/10 dark:bg-zinc-900 dark:focus:border-white/30"
      />
      {isOpen && trimmed && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded border border-black/10 bg-white shadow-lg dark:border-white/10 dark:bg-zinc-900">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">검색 결과 없음</li>
          ) : (
            results.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(n.id)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <span>
                    {n.name}
                    {n.ticker ? ` · ${n.ticker}` : ""}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{TYPE_LABEL[n.type]}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
