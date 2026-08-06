import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import type { NewsItem, Outlook } from "../src/lib/types.ts";

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

// GoogleGenAI({})는 생성 시 process.env.GEMINI_API_KEY(또는 GOOGLE_API_KEY)를 자동으로 읽는다.
const ai = new GoogleGenAI({});

const GEMINI_MODEL = "gemini-3.6-flash";

// Google이 무료 티어의 분당/일별 한도를 고정 수치로 더 이상 공개하지 않아서(계정별 동적 결정),
// 특정 한도를 근거로 한 값이 아니라 collect.mts와 같은 취지의 방어적 지연이다.
const GEMINI_DELAY_MS = 4000;

// 429(호출 한도 초과) 같은 일시적 에러는 몇 초 쉬었다가 다시 시도해본다.
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [5000, 10000, 15000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|rate.?limit/i.test(message);
}

// ---------- Supabase에서 읽어올 Asset 행 타입 ----------
interface AssetRow {
  id: string;
  ticker: string | null;
  name: string;
  price: number | null;
  change_percent: number | null;
  company_summary: string | null;
  news: NewsItem[] | null;
}

// ---------- Gemini에게 요청할 JSON 스키마 ----------
// Gemini의 구조화 출력은 "OpenAPI 3.0 스키마의 부분집합"만 지원한다고 SDK 타입 주석에 명시돼 있어,
// type/properties/items/required/description처럼 기본 키워드만 쓴다. 개수 제약(2~4개)은
// 스키마가 아니라 프롬프트 지시 + 아래 parseOutlookResponse의 코드 검증으로 처리한다.
const outlookResponseSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "종목 전망을 요약한 한국어 1~2문장. 투자 권유 표현 금지, 완곡한 어투.",
    },
    riskFactors: {
      type: "array",
      items: { type: "string" },
      description: "짧은 한국어 명사구 형태의 리스크 요인 2~4개.",
    },
  },
  required: ["summary", "riskFactors"],
};

// ---------- 프롬프트 생성 ----------
function buildPrompt(asset: AssetRow): string {
  const priceText =
    asset.price != null && asset.change_percent != null
      ? `${asset.price} (전일 대비 ${asset.change_percent > 0 ? "+" : ""}${asset.change_percent}%)`
      : "정보 없음";

  const newsText = (asset.news ?? [])
    .map((n, i) => `${i + 1}. [${n.publishedAt}] ${n.title} — ${n.summary} (출처: ${n.source})`)
    .join("\n");

  return `당신은 한국어로 금융 뉴스를 종합해 투자자에게 참고 정보를 제공하는 애널리스트입니다.
아래 "${asset.name}(${asset.ticker ?? "-"})" 종목에 대한 정보를 바탕으로, 전망 요약과 주요 리스크 요인을 작성하세요.

[기업 개요]
${asset.company_summary ?? "정보 없음"}

[현재가 / 등락률]
${priceText}

[최근 뉴스]
${newsText}

[작성 지침]
- summary는 위 뉴스에서 실제로 언급된 사실이나 요인에 근거해서, 한국어로 1~2문장으로 작성하세요. 뉴스에 없는 내용을 추측해서 덧붙이지 마세요.
- "매수", "매도", "사세요", "파세요", "지금 사야 한다", "추천한다"처럼 투자 행동을 지시하거나 권유하는 표현은 절대 사용하지 마세요. 이 요약은 투자 조언이 아니라 참고용 정보입니다.
- 단정적인 예측 대신, "~이 주요 변수로 꼽힌다", "~영향을 지켜볼 필요가 있다", "~가 부담으로 작용할 수 있다"처럼 완곡하고 근거를 밝히는 어투를 쓰세요.
- riskFactors는 완전한 문장이 아니라 "수출 규제 강화 가능성"처럼 짧은 한국어 명사구 형태로, 2~4개 작성하세요.
- summary와 riskFactors 모두 한국어로만 작성하세요.`;
}

// ---------- Gemini 호출 (429 등 일시적 에러는 재시도) ----------
async function callGemini(prompt: string): Promise<string> {
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const interaction = await ai.interactions.create({
          model: GEMINI_MODEL,
          input: prompt,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: outlookResponseSchema,
          },
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
    await sleep(GEMINI_DELAY_MS); // 성공/실패 상관없이 다음 종목 호출 전 항상 쉰다 (collect.mts와 동일한 방식)
  }
}

// ---------- 응답 파싱/검증 ----------
// JSON 스키마를 요청해도 모델이 100% 유효한 JSON을 돌려준다는 보장은 없으므로,
// 여기서 실패해도 스크립트를 죽이지 않고 이 종목만 실패 처리한다.
interface ParsedOutlook {
  summary: string;
  riskFactors: string[];
}

function parseOutlookResponse(raw: string): ParsedOutlook | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;

  const { summary, riskFactors } = obj;
  if (typeof summary !== "string" || summary.trim().length === 0) return null;
  if (!Array.isArray(riskFactors) || riskFactors.some((r) => typeof r !== "string")) return null;

  const cleanedRiskFactors = (riskFactors as string[]).map((r) => r.trim()).filter((r) => r.length > 0);
  if (cleanedRiskFactors.length === 0) return null;

  return { summary: summary.trim(), riskFactors: cleanedRiskFactors };
}

// ---------- 투자 권유 표현 감지 (경고용, 저장은 막지 않음) ----------
// CLAUDE.md 원칙: "투자 조언으로 읽힐 문구를 쓰지 않는다." 프롬프트에서 이미 금지했지만,
// 모델이 지시를 어길 가능성에 대비해 코드에서도 한 번 더 확인한다.
// "매수"/"매도" 같은 짧은 단어만 걸면 "매수세 둔화", "매도 물량" 같은 정상적인 서술형
// 표현까지 걸려서 오탐이 나므로, 명령형/권유형으로 끝나는 구체적인 어구만 감지한다.
// 걸리더라도 저장 자체를 막지는 않고(과탐 시 멀쩡한 전망을 날리는 게 더 나쁨),
// 결과 요약에 경고로만 표시해서 사람이 나중에 검토할 수 있게 한다.
const ADVICE_LIKE_PHRASES = [
  "매수하세요", "매도하세요", "사세요", "파세요",
  "매수를 추천", "매도를 추천", "추천합니다", "추천한다",
  "지금이 매수", "지금이 매도", "투자하세요", "사야 합니다", "팔아야 합니다",
];

function findAdviceLikeLanguage(summary: string, riskFactors: string[]): string | null {
  const combined = [summary, ...riskFactors].join(" ");
  for (const phrase of ADVICE_LIKE_PHRASES) {
    if (combined.includes(phrase)) return phrase;
  }
  return null;
}

// ---------- 종목 하나 처리 ----------
type AssetStatus = "success" | "fail" | "skip";

interface AssetResult {
  ticker: string;
  status: AssetStatus;
  notes: string[];
}

async function generateOutlookForAsset(asset: AssetRow): Promise<AssetResult> {
  const ticker = asset.ticker ?? `(id: ${asset.id})`;

  // 뉴스가 없으면 전망을 뒷받침할 근거가 없으므로 건너뛴다.
  if (!asset.news || asset.news.length === 0) {
    return {
      ticker,
      status: "skip",
      notes: ["최근 뉴스 없음 — collect.mts를 먼저 실행해 뉴스를 수집한 뒤 다시 시도하세요"],
    };
  }

  const prompt = buildPrompt(asset);

  let rawOutput: string;
  try {
    rawOutput = await callGemini(prompt);
  } catch (err) {
    return { ticker, status: "fail", notes: [`Gemini 호출 실패: ${(err as Error).message}`] };
  }

  const parsed = parseOutlookResponse(rawOutput);
  if (!parsed) {
    return { ticker, status: "fail", notes: ["Gemini 응답을 예상한 형식(summary, riskFactors)으로 해석하지 못함"] };
  }

  // 권유형 표현이 감지돼도 저장은 그대로 하고, 나중에 사람이 검토할 수 있게 경고만 남긴다.
  const notes: string[] = [];
  const adviceHit = findAdviceLikeLanguage(parsed.summary, parsed.riskFactors);
  if (adviceHit) {
    notes.push(`주의: 투자 권유처럼 보일 수 있는 표현("${adviceHit}") 포함 — 검토 권장`);
  }

  const outlook: Outlook = {
    summary: parsed.summary,
    riskFactors: parsed.riskFactors,
    generatedAt: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("nodes")
    .update({ outlook, updated_at: new Date().toISOString() })
    .eq("id", asset.id);

  if (error) {
    return { ticker, status: "fail", notes: [`DB 저장 실패: ${error.message}`] };
  }

  return { ticker, status: "success", notes };
}

// ---------- 스모크 테스트용 --limit 옵션 ----------
// node --env-file=.env.local scripts/generate-outlook.mts --limit=2 처럼 실행하면
// 처음 N개 종목만 처리한다. 전체 실행 전에 API가 실제로 동작하는지 값싸게 확인하기 위함.
function getLimitArg(): number | undefined {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return undefined;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------- 메인 ----------
async function main() {
  console.log("Supabase에서 Asset 노드 목록을 불러오는 중...");

  const { data: assets, error } = await supabase
    .from("nodes")
    .select("id, ticker, name, price, change_percent, company_summary, news")
    .eq("type", "Asset")
    .returns<AssetRow[]>();

  if (error) {
    console.error("Asset 노드 조회 실패:", error.message);
    process.exit(1);
  }
  if (!assets || assets.length === 0) {
    console.log("Asset 타입 노드가 없습니다. 먼저 종목 데이터를 등록하세요.");
    return;
  }

  const limit = getLimitArg();
  // --limit은 뉴스가 있는 종목 중에서만 골라야 스모크 테스트에서 실제로 Gemini를
  // 호출해본다. 그냥 앞에서부터 N개를 자르면, 마침 뉴스 없는 종목만 걸릴 경우
  // API를 한 번도 안 부르고 "성공"처럼 끝나버릴 수 있다.
  const assetsWithNews = assets.filter((a) => a.news && a.news.length > 0);
  if (limit && assetsWithNews.length === 0) {
    console.log("뉴스가 있는 Asset 노드가 없습니다. collect.mts를 먼저 실행해서 뉴스를 모아두세요.");
    return;
  }
  const targets = limit ? assetsWithNews.slice(0, limit) : assets;

  console.log(
    `총 ${targets.length}개 종목을 처리합니다` +
      (limit ? ` (--limit=${limit} 적용, 뉴스 있는 종목 중 일부)` : "") +
      `. 뉴스가 없는 종목은 건너뜁니다.\n`
  );

  const results: AssetResult[] = [];

  for (const asset of targets) {
    const label = asset.ticker ?? `(id: ${asset.id})`;
    console.log(`- ${label} 처리 중...`);
    const result = await generateOutlookForAsset(asset);
    results.push(result);
  }

  console.log("\n===== 결과 요약 =====");
  for (const r of results) {
    const label = r.status === "success" ? "[성공]" : r.status === "skip" ? "[건너뜀]" : "[실패]";
    console.log(`${label} ${r.ticker}${r.notes.length ? " — " + r.notes.join(", ") : ""}`);
  }

  const successCount = results.filter((r) => r.status === "success").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  console.log(`\n${results.length}개 중 성공 ${successCount}개, 건너뜀 ${skipCount}개, 실패 ${failCount}개.`);
}

main().catch((err) => {
  console.error("스크립트 실행 중 예외가 발생했습니다:", err);
  process.exit(1);
});
