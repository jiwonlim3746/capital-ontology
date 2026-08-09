import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import type { OntologyNode, Polarity } from "../src/lib/types.ts";

// ---------- 환경 변수 확인 ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "환경 변수가 부족합니다. web/.env.local에 GEMINI_API_KEY, SUPABASE_SERVICE_ROLE_KEY, " +
      "NEXT_PUBLIC_SUPABASE_URL이 모두 들어 있는지 확인하세요."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ai = new GoogleGenAI({});
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_DELAY_MS = 4000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [5000, 10000, 15000];
const TARGET_CONCEPT_COUNT = 10; // 1단계 목표(스펙 6장)
const PREVIEW_FILE = "scripts/generate-affects-preview.json";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|rate.?limit/i.test(message);
}

// ---------- Gemini 호출 ----------
async function callGemini(prompt: string, schema: object): Promise<string> {
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const interaction = await ai.interactions.create({
          model: GEMINI_MODEL,
          input: prompt,
          response_format: { type: "text", mime_type: "application/json", schema },
        });
        if (!interaction.output_text) {
          throw new Error("응답에 output_text가 없음");
        }
        return interaction.output_text;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRateLimitError(err)) {
          const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
          console.log(
            `  (호출 한도 초과로 보이는 에러 감지, ${backoff / 1000}초 대기 후 재시도 ${attempt + 1}/${MAX_RETRIES}회)`
          );
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  } finally {
    await sleep(GEMINI_DELAY_MS);
  }
}

// ---------- 투자 권유 표현 감지 (경고용, 저장은 막지 않음) ----------
const ADVICE_LIKE_PHRASES = [
  "매수하세요", "매도하세요", "사세요", "파세요",
  "매수를 추천", "매도를 추천", "추천합니다", "추천한다",
  "지금이 매수", "지금이 매도", "투자하세요", "사야 합니다", "팔아야 합니다",
];

function findAdviceLikeLanguage(text: string): string | null {
  for (const phrase of ADVICE_LIKE_PHRASES) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
}

// ---------- CLI 옵션 ----------
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
function getLimitArg(): number | undefined {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return undefined;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// =====================================================================
// 공통 타입/유틸
// =====================================================================

type ConceptCategory = NonNullable<OntologyNode["category"]>;
const VALID_CATEGORIES: ConceptCategory[] = ["거시", "기술", "정책", "지정학"];
const VALID_POLARITIES: Polarity[] = ["positive", "negative", "mixed"];

interface ConceptRow {
  id: string;
  name: string;
  category: ConceptCategory | null;
  description: string | null;
}

interface AssetRow {
  id: string;
  ticker: string | null;
  name: string;
  company_summary: string | null;
}

function formatAssetRoster(assets: AssetRow[]): string {
  return assets
    .map((a, i) => `${i + 1}. ${a.name}(${a.ticker ?? "-"}) — ${a.company_summary ?? "개요 정보 없음"}`)
    .join("\n");
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// =====================================================================
// Phase A: 신규 Concept 노드 "계산" (DB 쓰기는 별도 apply 함수에서)
// =====================================================================

interface NewConceptCandidate {
  name?: unknown;
  slug?: unknown;
  category?: unknown;
  description?: unknown;
}

interface ValidatedNewConcept {
  id: string;
  slug: string;
  name: string;
  category: ConceptCategory;
  description: string;
}

interface PhaseAResult {
  label: string;
  status: "candidate" | "fail" | "skip";
  notes: string[];
}

const newConceptsResponseSchema = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "개념의 한국어 이름. 예: '금리', '관세'." },
          slug: {
            type: "string",
            description:
              "개념을 나타내는 소문자 영어 슬러그. 소문자 알파벳/숫자/하이픈만 사용. 예: '금리'→'rates', '관세'→'tariffs'.",
          },
          category: { type: "string", description: "정확히 '거시', '기술', '정책', '지정학' 중 하나 (다른 값 금지)." },
          description: { type: "string", description: "개념을 정의하는 한국어 1문장." },
        },
        required: ["name", "slug", "category", "description"],
      },
    },
  },
  required: ["concepts"],
};

function buildPhaseAPrompt(existingConcepts: ConceptRow[], assets: AssetRow[], needed: number): string {
  const existingNames = existingConcepts.map((c) => c.name).join(", ");
  const categoryCounts = VALID_CATEGORIES.map(
    (cat) => `${cat} ${existingConcepts.filter((c) => c.category === cat).length}개`
  ).join(", ");

  return `당신은 금융 지식 그래프에 들어갈 "개념(Concept)" 노드를 설계하는 애널리스트입니다.
이 그래프는 개념이 종목에 미치는 영향(AFFECTS)을 표현하는 데 쓰입니다. 아래 조건에 맞는
새로운 개념 정확히 ${needed}개를 제안하세요.

[이미 존재하는 개념 — 이름이나 의미가 겹치는 개념은 제안하지 마세요]
${existingNames}

[현재 개념 카테고리 분포]
${categoryCounts}
특정 카테고리에 쏠리지 않도록, 아직 다뤄지지 않았거나 적은 카테고리(정책, 지정학 등)도
균형 있게 포함해 주세요. 단, 억지로 끼워맞추지는 마세요.

[현재 데이터베이스의 종목 목록 — 새 개념은 이 중 최소 1개 이상과 그럴듯한 인과관계를 가져야 합니다]
${formatAssetRoster(assets)}

[작성 지침]
- category는 반드시 "거시", "기술", "정책", "지정학" 중 정확히 하나여야 합니다. 다른 표현(예: "매크로", "정치")은 쓰지 마세요.
- slug는 소문자 영어와 하이픈(-)만 사용하세요. 공백, 한글, 특수문자, 대문자를 쓰지 마세요.
- description은 개념을 정의하는 한국어 1문장으로, 완곡하고 사실 서술적인 어투로 작성하세요.
- name과 description 모두 한국어로만 작성하세요.
- 완전히 동떨어져서 위 종목들과 어떤 그럴듯한 연결고리도 없는 개념은 제안하지 마세요.`;
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseNewConceptsResponse(raw: string): NewConceptCandidate[] | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.concepts)) return null;
  return obj.concepts as NewConceptCandidate[];
}

function validateNewConcepts(
  candidates: NewConceptCandidate[],
  existingIds: Set<string>,
  needed: number
): { accepted: ValidatedNewConcept[]; results: PhaseAResult[] } {
  const accepted: ValidatedNewConcept[] = [];
  const results: PhaseAResult[] = [];
  const seenSlugs = new Set<string>();

  for (const c of candidates) {
    const rawName = typeof c.name === "string" ? c.name.trim() : "";
    const rawSlug = typeof c.slug === "string" ? c.slug : "";
    const rawCategory = typeof c.category === "string" ? c.category : "";
    const rawDescription = typeof c.description === "string" ? c.description.trim() : "";
    const label = rawName || rawSlug || "(이름 없음)";

    if (!rawName) {
      results.push({ label, status: "skip", notes: ["name이 비어 있음"] });
      continue;
    }
    if (!rawDescription) {
      results.push({ label, status: "skip", notes: ["description이 비어 있음"] });
      continue;
    }
    if (!VALID_CATEGORIES.includes(rawCategory as ConceptCategory)) {
      results.push({ label, status: "skip", notes: [`알 수 없는 category 값: "${rawCategory}"`] });
      continue;
    }

    const slug = sanitizeSlug(rawSlug);
    if (!slug) {
      results.push({ label, status: "skip", notes: [`슬러그를 정리한 뒤 빈 문자열이 됨 (원본: "${rawSlug}")`] });
      continue;
    }
    const id = `concept-${slug}`;
    if (existingIds.has(id) || seenSlugs.has(slug)) {
      results.push({ label, status: "skip", notes: [`슬러그 충돌: "${slug}" (기존 개념 또는 이번 배치 내 중복)`] });
      continue;
    }

    if (accepted.length >= needed) {
      results.push({ label, status: "skip", notes: [`목표 개수(${needed}개)를 이미 채워서 건너뜀`] });
      continue;
    }

    seenSlugs.add(slug);
    accepted.push({ id, slug, name: rawName, category: rawCategory as ConceptCategory, description: rawDescription });
  }

  return { accepted, results };
}

// DB에 쓰지 않고 후보만 계산한다 (dry-run/실제 실행 공통).
async function computeNewConcepts(
  existingConcepts: ConceptRow[],
  assets: AssetRow[]
): Promise<{ candidates: ValidatedNewConcept[]; results: PhaseAResult[] }> {
  const needed = Math.max(0, TARGET_CONCEPT_COUNT - existingConcepts.length);
  if (needed === 0) {
    console.log(
      `[Phase A] 개념 노드가 이미 ${existingConcepts.length}개로 목표(${TARGET_CONCEPT_COUNT}개)를 채웠습니다. 건너뜁니다.\n`
    );
    return { candidates: [], results: [] };
  }

  console.log(
    `[Phase A] 개념 노드 ${existingConcepts.length}개 → 목표 ${TARGET_CONCEPT_COUNT}개. ${needed}개 후보를 생성합니다.`
  );

  const existingIds = new Set(existingConcepts.map((c) => c.id));
  const prompt = buildPhaseAPrompt(existingConcepts, assets, needed);

  let rawOutput: string;
  try {
    rawOutput = await callGemini(prompt, newConceptsResponseSchema);
  } catch (err) {
    return {
      candidates: [],
      results: [{ label: "(Phase A 전체)", status: "fail", notes: [`Gemini 호출 실패: ${(err as Error).message}`] }],
    };
  }

  const raw = parseNewConceptsResponse(rawOutput);
  if (!raw) {
    return {
      candidates: [],
      results: [
        { label: "(Phase A 전체)", status: "fail", notes: ["Gemini 응답을 예상한 형식(concepts 배열)으로 해석하지 못함"] },
      ],
    };
  }

  const { accepted, results } = validateNewConcepts(raw, existingIds, needed);
  for (const c of accepted) {
    results.push({ label: c.name, status: "candidate", notes: [`id: ${c.id}`] });
  }
  return { candidates: accepted, results };
}

// 실제로 DB에 insert한다. dry-run이 아닐 때만 호출.
async function applyNewConcepts(candidates: ValidatedNewConcept[]): Promise<{ inserted: ConceptRow[]; failNotes: string[] }> {
  const inserted: ConceptRow[] = [];
  const failNotes: string[] = [];
  for (const c of candidates) {
    const { error } = await supabase.from("nodes").insert({
      id: c.id,
      type: "Concept",
      name: c.name,
      category: c.category,
      description: c.description,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      failNotes.push(`${c.name}: DB 저장 실패 — ${error.message}`);
      continue;
    }
    inserted.push({ id: c.id, name: c.name, category: c.category, description: c.description });
  }
  return { inserted, failNotes };
}

// =====================================================================
// Phase B: Concept → Asset AFFECTS "차이(diff) 계산" (DB 쓰기는 별도 apply 함수에서)
// =====================================================================

interface AffectsCandidate {
  ticker?: unknown;
  polarity?: unknown;
  strength?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

interface AffectsValue {
  polarity: Polarity;
  strength: number;
  confidence: number;
  rationale: string;
}

interface EdgeDiffItem {
  ticker: string;
  assetId: string;
  edgeId: string;
  action: "add" | "update" | "remove" | "unchanged";
  before?: AffectsValue;
  after?: AffectsValue;
}

interface PhaseBResult {
  concept: ConceptRow;
  status: "success" | "fail" | "skip";
  diff: EdgeDiffItem[];
  notes: string[];
}

const affectsResponseSchema = {
  type: "object",
  properties: {
    affectedAssets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "영향을 받는 종목의 티커. 반드시 아래 종목 목록에 있는 값과 정확히 일치해야 함." },
          polarity: { type: "string", description: "정확히 'positive', 'negative', 'mixed' 중 하나 (다른 값 금지)." },
          strength: { type: "number", description: "관계의 강도(직접성). 1(약함)~5(강함) 사이의 정수." },
          confidence: { type: "number", description: "이 판단에 대한 확신도. 0~1 사이 소수. 낮게(보수적으로) 잡을 것." },
          rationale: { type: "string", description: "왜 이 개념이 이 종목에 영향을 주는지 설명하는 한국어 1문장." },
        },
        required: ["ticker", "polarity", "strength", "confidence", "rationale"],
      },
      description: "이 개념의 영향을 실질적으로 받는다고 판단되는 종목만 포함. 없으면 빈 배열.",
    },
  },
  required: ["affectedAssets"],
};

function buildPhaseBPrompt(concept: ConceptRow, assets: AssetRow[]): string {
  return `당신은 한국어로 금융 개념과 종목 사이의 인과관계를 분석하는 애널리스트입니다.
아래 "${concept.name}" 개념(카테고리: ${concept.category ?? "-"})이 아래 종목 목록 중 어떤 종목에
영향을 미치는지 판단하세요.

[개념 설명]
${concept.description ?? "설명 없음"}

[현재 데이터베이스의 종목 목록]
${formatAssetRoster(assets)}

[판단 기준]
- polarity: 이 개념이 강화될 때(예: 금리가 오를 때) 해당 종목에 긍정적(positive)/부정적(negative)/상황에 따라
  방향이 갈리는(mixed) 영향을 주는지.
- strength: 관계의 직접성·강도. 1(간접적/약함)~5(직접적/강함) 사이의 정수.
- confidence: 이 판단 자체에 대한 확신도. 0~1 사이 소수.

[확신도(confidence) 보정 기준 — 반드시 지킬 것]
이 관계들은 사람이 아직 검증하지 않은 AI의 첫 추론이므로 보수적으로 시작해야 합니다.
- "금리가 오르면 성장주 밸류에이션이 부담된다"처럼 이미 널리 알려진 교과서적 인과관계가 아니라면
  confidence는 0.3~0.6 사이로 설정하세요.
- 예시: "양자컴퓨팅 연구 확대가 반도체 수요로 이어질 수 있다는 관측"처럼 근거가 아직 약한 경우
  confidence 0.4 수준이 적절합니다. rationale에도 근거가 아직 약하다는 점을 자연스럽게 드러내세요.
- confidence 0.7 이상은 실증적으로 매우 잘 알려진 관계에만 사용하세요.

[작성 지침]
- 모든 종목을 억지로 연결하지 마세요. 이 개념과 실질적인 인과관계가 있다고 판단되는 종목만 포함하고,
  근거가 지나치게 약하거나 억지스러운 연결은 아예 포함하지 마세요. 이 개념이 어느 종목에도 뚜렷한
  영향을 주지 않는다고 판단되면 빈 배열을 반환하는 것이 정답입니다.
- 다만 각 종목을 한 번씩은 검토한 뒤 판단하세요. 확신이 안 선다고 전부 제외하지 말고, 근거가 있다면
  confidence를 낮게라도 잡아서 포함하세요.
- ticker는 반드시 위 종목 목록의 티커와 정확히 일치해야 합니다.
- "매수", "매도", "사세요", "파세요", "지금 사야 한다", "추천한다"처럼 투자 행동을 지시하거나
  권유하는 표현은 절대 사용하지 마세요. rationale은 투자 조언이 아니라 참고용 설명입니다.
- rationale은 한국어로 완곡하고 근거를 밝히는 어투의 1문장으로 작성하세요.`;
}

function parseAffectsResponse(raw: string): AffectsCandidate[] | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.affectedAssets)) return null;
  return obj.affectedAssets as AffectsCandidate[];
}

function validateAffects(
  candidates: AffectsCandidate[],
  tickerToAsset: Map<string, AssetRow>
): { accepted: Map<string, AffectsValue>; notes: string[] } {
  // key: assetId
  const accepted = new Map<string, AffectsValue>();
  const notes: string[] = [];

  for (const c of candidates) {
    const rawTicker = typeof c.ticker === "string" ? c.ticker.trim().toUpperCase() : "";
    const asset = tickerToAsset.get(rawTicker);
    if (!asset || !asset.ticker) {
      notes.push(`알 수 없는 ticker "${rawTicker}" 항목 건너뜀`);
      continue;
    }

    const rawPolarity = typeof c.polarity === "string" ? c.polarity : "";
    if (!VALID_POLARITIES.includes(rawPolarity as Polarity)) {
      notes.push(`${asset.ticker}: 알 수 없는 polarity 값 "${rawPolarity}" — 항목 건너뜀`);
      continue;
    }

    const rawRationale = typeof c.rationale === "string" ? c.rationale.trim() : "";
    if (!rawRationale) {
      notes.push(`${asset.ticker}: rationale이 비어 있음 — 항목 건너뜀`);
      continue;
    }

    const rawStrength = typeof c.strength === "number" ? c.strength : NaN;
    const rawConfidence = typeof c.confidence === "number" ? c.confidence : NaN;
    if (!Number.isFinite(rawStrength) || !Number.isFinite(rawConfidence)) {
      notes.push(`${asset.ticker}: strength/confidence가 숫자가 아님 — 항목 건너뜀`);
      continue;
    }

    const strength = clamp(Math.round(rawStrength), 1, 5);
    const confidence = Math.round(clamp(rawConfidence, 0, 1) * 100) / 100;
    if (strength !== rawStrength) notes.push(`${asset.ticker}: strength 값(${rawStrength})을 ${strength}로 보정함`);
    if (confidence !== rawConfidence) notes.push(`${asset.ticker}: confidence 값(${rawConfidence})을 ${confidence}로 보정함`);

    const adviceHit = findAdviceLikeLanguage(rawRationale);
    if (adviceHit) {
      notes.push(`${asset.ticker}: 주의 — 투자 권유처럼 보일 수 있는 표현("${adviceHit}") 포함, 검토 권장`);
    }

    accepted.set(asset.id, { polarity: rawPolarity as Polarity, strength, confidence, rationale: rawRationale });
  }

  return { accepted, notes };
}

interface ExistingEdgeRow {
  id: string;
  target: string;
  polarity: Polarity | null;
  strength: number | null;
  confidence: number | null;
  rationale: string | null;
}

function sameValue(a: AffectsValue, b: AffectsValue): boolean {
  return a.polarity === b.polarity && a.strength === b.strength && a.confidence === b.confidence && a.rationale === b.rationale;
}

function buildDiff(
  conceptId: string,
  existingEdges: ExistingEdgeRow[],
  newByAssetId: Map<string, AffectsValue>,
  assetIdToTicker: Map<string, string>,
  conceptSlug: string
): EdgeDiffItem[] {
  const existingByTarget = new Map(existingEdges.map((e) => [e.target, e]));
  const allTargets = new Set([...existingByTarget.keys(), ...newByAssetId.keys()]);
  const diff: EdgeDiffItem[] = [];

  for (const assetId of allTargets) {
    const existing = existingByTarget.get(assetId);
    const next = newByAssetId.get(assetId);
    const ticker = assetIdToTicker.get(assetId) ?? assetId;
    const edgeId = `e-affects-${conceptSlug}-${ticker.toLowerCase()}`;

    if (existing && !next) {
      diff.push({
        ticker,
        assetId,
        edgeId: existing.id,
        action: "remove",
        before: {
          polarity: (existing.polarity ?? "positive") as Polarity,
          strength: existing.strength ?? 0,
          confidence: existing.confidence ?? 0,
          rationale: existing.rationale ?? "",
        },
      });
    } else if (!existing && next) {
      diff.push({ ticker, assetId, edgeId, action: "add", after: next });
    } else if (existing && next) {
      const before: AffectsValue = {
        polarity: (existing.polarity ?? "positive") as Polarity,
        strength: existing.strength ?? 0,
        confidence: existing.confidence ?? 0,
        rationale: existing.rationale ?? "",
      };
      diff.push({
        ticker,
        assetId,
        edgeId: existing.id,
        action: sameValue(before, next) ? "unchanged" : "update",
        before,
        after: next,
      });
    }
  }

  return diff;
}

// DB에 쓰지 않고 diff만 계산한다 (dry-run/실제 실행 공통).
async function computePhaseB(concept: ConceptRow, assets: AssetRow[]): Promise<PhaseBResult> {
  const { data: existingEdges, error: fetchError } = await supabase
    .from("edges")
    .select("id, target, polarity, strength, confidence, rationale")
    .eq("source", concept.id)
    .eq("type", "AFFECTS")
    .returns<ExistingEdgeRow[]>();

  if (fetchError) {
    return { concept, status: "fail", diff: [], notes: [`기존 관계 조회 실패: ${fetchError.message}`] };
  }

  const tickerToAsset = new Map(assets.filter((a) => a.ticker).map((a) => [a.ticker!.toUpperCase(), a] as const));
  const assetIdToTicker = new Map(assets.filter((a) => a.ticker).map((a) => [a.id, a.ticker!] as const));

  // 이 개념에서 나가는 AFFECTS 엣지 중에는 Concept→Concept인 것(예: 금리→인플레이션)도 섞여 있을 수
  // 있는데, 이번 스크립트는 Concept→Asset만 다루기로 했으므로 대상이 Asset이 아닌 엣지는 diff
  // 계산에서 아예 제외한다. 안 그러면 "이번엔 판단 대상이 아니었으니 삭제"로 오인해서
  // 범위 밖인 개념-개념 관계까지 지워버리는 사고가 난다 (실제로 dry-run에서 한 번 발생해서 잡음).
  const existingAssetEdges = (existingEdges ?? []).filter((e) => assetIdToTicker.has(e.target));

  const prompt = buildPhaseBPrompt(concept, assets);
  let rawOutput: string;
  try {
    rawOutput = await callGemini(prompt, affectsResponseSchema);
  } catch (err) {
    return { concept, status: "fail", diff: [], notes: [`Gemini 호출 실패: ${(err as Error).message}`] };
  }

  const raw = parseAffectsResponse(rawOutput);
  if (!raw) {
    return { concept, status: "fail", diff: [], notes: ["Gemini 응답을 예상한 형식(affectedAssets 배열)으로 해석하지 못함"] };
  }

  const { accepted, notes } = validateAffects(raw, tickerToAsset);
  const conceptSlug = concept.id.replace(/^concept-/, "");
  const diff = buildDiff(concept.id, existingAssetEdges, accepted, assetIdToTicker, conceptSlug);

  const meaningful = diff.filter((d) => d.action !== "unchanged");
  return {
    concept,
    status: meaningful.length > 0 || accepted.size > 0 ? "success" : "skip",
    diff,
    notes,
  };
}

// diff를 실제로 반영한다 (add: insert, update: update, remove: delete). dry-run이 아닐 때만 호출.
async function applyDiff(concept: ConceptRow, diff: EdgeDiffItem[]): Promise<string[]> {
  const failNotes: string[] = [];
  const nowIso = new Date().toISOString();

  const toInsert = diff.filter((d) => d.action === "add");
  const toUpdate = diff.filter((d) => d.action === "update");
  const toRemove = diff.filter((d) => d.action === "remove");

  if (toInsert.length > 0) {
    const rows = toInsert.map((d) => ({
      id: d.edgeId,
      source: concept.id,
      target: d.assetId,
      type: "AFFECTS" as const,
      direction: "단방향" as const,
      polarity: d.after!.polarity,
      strength: d.after!.strength,
      confidence: d.after!.confidence,
      rationale: d.after!.rationale,
      updated_at: nowIso,
    }));
    const { error } = await supabase.from("edges").insert(rows);
    if (error) failNotes.push(`추가 실패: ${error.message}`);
  }

  for (const d of toUpdate) {
    const { error } = await supabase
      .from("edges")
      .update({
        polarity: d.after!.polarity,
        strength: d.after!.strength,
        confidence: d.after!.confidence,
        rationale: d.after!.rationale,
        updated_at: nowIso,
      })
      .eq("id", d.edgeId);
    if (error) failNotes.push(`${d.ticker} 갱신 실패: ${error.message}`);
  }

  for (const d of toRemove) {
    const { error } = await supabase.from("edges").delete().eq("id", d.edgeId);
    if (error) failNotes.push(`${d.ticker} 삭제 실패: ${error.message}`);
  }

  return failNotes;
}

// ---------- diff 출력 ----------
function printDiff(conceptName: string, diff: EdgeDiffItem[], notes: string[]): void {
  const meaningful = diff.filter((d) => d.action !== "unchanged");
  console.log(`[개념] ${conceptName}`);
  // notes가 있으면(예: Gemini 호출 실패) "변경 없음"이라고 하면 오해의 소지가 있어서
  // notes도 없을 때만 이 메시지를 띄운다.
  if (meaningful.length === 0 && notes.length === 0) {
    console.log("  (변경 없음)");
  }
  for (const d of meaningful) {
    if (d.action === "add") {
      console.log(
        `  + 추가: ${d.ticker} (${d.after!.polarity}, 강도 ${d.after!.strength}, 신뢰도 ${d.after!.confidence}) — "${d.after!.rationale}"`
      );
    } else if (d.action === "update") {
      console.log(
        `  ~ 변경: ${d.ticker} (신뢰도 ${d.before!.confidence}→${d.after!.confidence}, 강도 ${d.before!.strength}→${d.after!.strength})`
      );
    } else if (d.action === "remove") {
      console.log(`  - 제거: ${d.ticker} (기존: "${d.before!.rationale}") — 이번 판단에서는 빠짐`);
    }
  }
  for (const n of notes) {
    console.log(`  ! ${n}`);
  }
}

// =====================================================================
// 메인
// =====================================================================

async function main() {
  const dryRun = hasFlag("--dry-run");
  const limit = getLimitArg();

  if (dryRun) {
    console.log("========================================");
    console.log(" DRY RUN 모드 — DB에는 아무것도 저장되지 않습니다.");
    console.log("========================================\n");
  }

  console.log("Supabase에서 Concept/Asset 노드 목록을 불러오는 중...");
  const [conceptsRes, assetsRes] = await Promise.all([
    supabase.from("nodes").select("id, name, category, description").eq("type", "Concept").returns<ConceptRow[]>(),
    supabase.from("nodes").select("id, ticker, name, company_summary").eq("type", "Asset").returns<AssetRow[]>(),
  ]);

  if (conceptsRes.error) {
    console.error("Concept 노드 조회 실패:", conceptsRes.error.message);
    process.exit(1);
  }
  if (assetsRes.error) {
    console.error("Asset 노드 조회 실패:", assetsRes.error.message);
    process.exit(1);
  }

  const existingConcepts = conceptsRes.data ?? [];
  const assets = assetsRes.data ?? [];

  if (assets.length === 0) {
    console.log("Asset 타입 노드가 없습니다. 먼저 종목 데이터를 등록하세요.");
    return;
  }

  // ---------- Phase A ----------
  let phaseAResults: PhaseAResult[] = [];
  let candidateConcepts: ValidatedNewConcept[] = [];
  let insertedConcepts: ConceptRow[] = [];

  if (limit) {
    console.log(
      `[Phase A] --limit=${limit}: 신규 개념 생성은 건너뜁니다 (되돌리기 어려운 데이터라 스모크 테스트에는 포함하지 않음).\n`
    );
  } else {
    const computed = await computeNewConcepts(existingConcepts, assets);
    phaseAResults = computed.results;
    candidateConcepts = computed.candidates;

    if (candidateConcepts.length > 0) {
      console.log("\n[Phase A 후보]");
      for (const c of candidateConcepts) {
        console.log(`  + ${c.name} (${c.id}, ${c.category}) — ${c.description}`);
      }
      console.log("");
    }

    if (!dryRun && candidateConcepts.length > 0) {
      const applied = await applyNewConcepts(candidateConcepts);
      insertedConcepts = applied.inserted;
      for (const note of applied.failNotes) {
        phaseAResults.push({ label: "(저장)", status: "fail", notes: [note] });
      }
    }
  }

  // ---------- Phase B ----------
  // dry-run에서는 아직 DB에 없는 Phase A 후보도 "있다고 가정"하고 관계까지 미리 보여준다.
  const conceptsForPhaseB: ConceptRow[] = existingConcepts.concat(
    dryRun
      ? candidateConcepts.map((c) => ({ id: c.id, name: c.name, category: c.category, description: c.description }))
      : insertedConcepts
  );

  if (conceptsForPhaseB.length === 0) {
    console.log("Concept 타입 노드가 없습니다. AFFECTS 관계를 생성할 대상이 없습니다.");
    return;
  }

  const targets = limit ? conceptsForPhaseB.slice(0, limit) : conceptsForPhaseB;
  console.log(
    `[Phase B] 총 ${targets.length}개 개념에 대해 AFFECTS 관계를 판단합니다` + (limit ? ` (--limit=${limit} 적용)` : "") + `.\n`
  );

  const phaseBResults: PhaseBResult[] = [];
  for (const concept of targets) {
    console.log(`- ${concept.name} 처리 중...`);
    const result = await computePhaseB(concept, assets);
    phaseBResults.push(result);

    printDiff(concept.name, result.diff, result.notes);

    if (!dryRun && result.status !== "fail") {
      const failNotes = await applyDiff(concept, result.diff);
      for (const note of failNotes) {
        console.log(`  ! ${note}`);
      }
    }
    console.log("");
  }

  // ---------- 미리보기 파일 저장 (dry-run/실제 실행 공통, 감사 기록용) ----------
  const previewPayload = {
    dryRun,
    generatedAt: new Date().toISOString(),
    phaseA: { candidates: candidateConcepts, results: phaseAResults },
    phaseB: phaseBResults.map((r) => ({
      conceptId: r.concept.id,
      conceptName: r.concept.name,
      status: r.status,
      notes: r.notes,
      diff: r.diff.filter((d) => d.action !== "unchanged"),
    })),
  };
  try {
    writeFileSync(PREVIEW_FILE, JSON.stringify(previewPayload, null, 2), "utf-8");
    console.log(`전체 결과를 ${PREVIEW_FILE} 파일에도 저장했습니다.\n`);
  } catch (err) {
    console.log(`(참고) 미리보기 파일 저장 실패: ${(err as Error).message}\n`);
  }

  // ---------- 최종 요약 ----------
  console.log("===== 최종 요약 =====");
  if (dryRun) {
    console.log("DRY RUN — 위 내용은 미리보기이며 실제로 저장되지 않았습니다.");
    console.log("확인 후 문제없으면 --dry-run 없이 다시 실행하세요.\n");
  }
  console.log(`Phase A: 후보 ${candidateConcepts.length}개 중 ${insertedConcepts.length}개 저장됨.`);
  const addCount = phaseBResults.reduce((s, r) => s + r.diff.filter((d) => d.action === "add").length, 0);
  const updateCount = phaseBResults.reduce((s, r) => s + r.diff.filter((d) => d.action === "update").length, 0);
  const removeCount = phaseBResults.reduce((s, r) => s + r.diff.filter((d) => d.action === "remove").length, 0);
  const failCount = phaseBResults.filter((r) => r.status === "fail").length;
  console.log(
    `Phase B: 개념 ${phaseBResults.length}개 처리 — 추가 ${addCount}건, 변경 ${updateCount}건, 삭제 ${removeCount}건, 실패 ${failCount}개.`
  );
}

main().catch((err) => {
  console.error("스크립트 실행 중 예외가 발생했습니다:", err);
  process.exit(1);
});
