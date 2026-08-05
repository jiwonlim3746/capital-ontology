import { createClient } from "@supabase/supabase-js";
import type { NewsItem } from "../src/lib/types.ts";

// ---------- 환경 변수 확인 ----------
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!FINNHUB_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "환경 변수가 부족합니다. web/.env.local에 FINNHUB_API_KEY, SUPABASE_SERVICE_ROLE_KEY, " +
      "NEXT_PUBLIC_SUPABASE_URL이 모두 들어 있는지 확인하세요."
  );
  process.exit(1);
}

// service_role 키는 RLS(읽기 전용 정책)를 우회해서 쓰기가 가능하다.
// 브라우저에 절대 노출되면 안 되므로, 이 클라이언트는 이 스크립트 안에서만 사용한다.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- Finnhub 응답 타입 ----------
interface FinnhubProfile2 {
  ticker?: string;
  name?: string;
  logo?: string;
  marketCapitalization?: number;
}

interface FinnhubQuote {
  c: number; // 현재가
  d: number;
  dp: number; // 등락률(%)
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

interface FinnhubCompanyNewsItem {
  category: string;
  datetime: number; // Unix seconds
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

// ---------- Finnhub 호출 (분당 60회 제한 대응) ----------
// 종목 하나당 호출이 3번(profile2/quote/company-news)이라
// "종목 사이"에만 쉬면 종목 수가 늘어날 때 순간적으로 분당 제한을 넘을 수 있다.
// 호출 하나하나마다 쉬어야 종목 수와 무관하게 항상 초당 ~1회로 유지된다.
const FINNHUB_DELAY_MS = 1100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finnhubFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://finnhub.io/api/v1${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("token", FINNHUB_API_KEY as string);

  const res = await fetch(url);
  await sleep(FINNHUB_DELAY_MS); // 다음 호출 전 항상 쉰다 (성공/실패 상관없이)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---------- 시가총액 포맷 (marketCapitalization은 "백만 달러" 단위) ----------
// 딱 떨어지는 값이면 "260B"처럼 소수점 없이, 아니면 "5.1T"처럼 소수점 1자리로 표기
// (기존 목업 데이터의 표기 스타일과 맞춤).
function formatNumber(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

function formatMarketCap(marketCapMillions: number | undefined | null): string | undefined {
  if (marketCapMillions == null || !Number.isFinite(marketCapMillions) || marketCapMillions <= 0) {
    return undefined; // 값이 없으면 필드 자체를 생략 (기존 값을 지우지 않기 위해)
  }
  const MILLION_PER_TRILLION = 1_000_000;
  const MILLION_PER_BILLION = 1_000;

  if (marketCapMillions >= MILLION_PER_TRILLION) {
    return `${formatNumber(marketCapMillions / MILLION_PER_TRILLION)}T`;
  }
  if (marketCapMillions >= MILLION_PER_BILLION) {
    return `${formatNumber(marketCapMillions / MILLION_PER_BILLION)}B`;
  }
  // 10억 달러 미만 소형주: 백만 달러 단위 그대로 표기
  return `${Math.max(1, Math.round(marketCapMillions))}M`;
}

// ---------- 종목 하나 처리 ----------
type AssetStatus = "success" | "partial" | "fail";

interface AssetResult {
  ticker: string;
  status: AssetStatus;
  notes: string[];
}

async function collectForAsset(id: string, ticker: string): Promise<AssetResult> {
  const notes: string[] = [];
  const payload: Record<string, unknown> = {};

  // 1) 회사 프로필 (로고, 시가총액)
  try {
    const profile = await finnhubFetch<FinnhubProfile2>("/stock/profile2", { symbol: ticker });
    if (profile.logo) {
      payload.logo = profile.logo;
    }
    const marketCap = formatMarketCap(profile.marketCapitalization);
    if (marketCap) {
      payload.market_cap = marketCap;
    }
    if (!profile.logo && marketCap === undefined) {
      notes.push("프로필 정보 없음(심볼 확인 필요)");
    }
  } catch (err) {
    notes.push(`프로필 조회 실패: ${(err as Error).message}`);
  }

  // 2) 현재가/등락률
  try {
    const quote = await finnhubFetch<FinnhubQuote>("/quote", { symbol: ticker });
    const isEmptyQuote = quote.c === 0 && quote.pc === 0 && quote.h === 0 && quote.l === 0;
    if (isEmptyQuote) {
      notes.push("시세 데이터 없음(심볼 확인 필요)");
    } else {
      payload.price = quote.c;
      payload.change_percent = quote.dp;
    }
  } catch (err) {
    notes.push(`시세 조회 실패: ${(err as Error).message}`);
  }

  // 3) 최근 뉴스 (최근 7일 중 최신 5건, 스펙 5.3 "종목당 최근 5건까지만")
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const toStr = to.toISOString().slice(0, 10);
    const fromStr = from.toISOString().slice(0, 10);

    const rawNews = await finnhubFetch<FinnhubCompanyNewsItem[]>("/company-news", {
      symbol: ticker,
      from: fromStr,
      to: toStr,
    });

    const news: NewsItem[] = rawNews
      .slice()
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 5)
      .map((item) => ({
        title: item.headline,
        summary: item.summary,
        url: item.url,
        publishedAt: new Date(item.datetime * 1000).toISOString().slice(0, 10),
        source: item.source,
        // Finnhub 무료 티어는 감성(sentiment) 정보를 제공하지 않는다.
        // 실제 감성 분석은 향후 Claude 기반 단계(스펙 7.8)에서 채워 넣을 예정이며,
        // 그 전까지는 "neutral"을 임시값으로 둔다.
        sentiment: "neutral" as const,
      }));

    payload.news = news; // 0건이어도 "최근 뉴스 없음"은 유효한 결과이므로 그대로 저장
    if (news.length === 0) {
      notes.push("최근 7일 뉴스 없음");
    }
  } catch (err) {
    notes.push(`뉴스 조회 실패: ${(err as Error).message}`);
  }

  if (Object.keys(payload).length === 0) {
    return { ticker, status: "fail", notes };
  }

  payload.updated_at = new Date().toISOString();

  const { error } = await supabase.from("nodes").update(payload).eq("id", id);
  if (error) {
    notes.push(`DB 저장 실패: ${error.message}`);
    return { ticker, status: "fail", notes };
  }

  return { ticker, status: notes.length > 0 ? "partial" : "success", notes };
}

// ---------- 메인 ----------
async function main() {
  console.log("Supabase에서 Asset 노드 목록을 불러오는 중...");

  const { data: assets, error } = await supabase
    .from("nodes")
    .select("id, ticker")
    .eq("type", "Asset")
    .returns<{ id: string; ticker: string | null }[]>();

  if (error) {
    console.error("Asset 노드 조회 실패:", error.message);
    process.exit(1);
  }
  if (!assets || assets.length === 0) {
    console.log("Asset 타입 노드가 없습니다. 먼저 종목 데이터를 등록하세요.");
    return;
  }

  console.log(
    `총 ${assets.length}개 종목을 처리합니다. (종목당 API 호출 3회, 약 ${((assets.length * 3 * FINNHUB_DELAY_MS) / 1000).toFixed(0)}초 소요 예상)\n`
  );

  const results: AssetResult[] = [];

  for (const asset of assets) {
    if (!asset.ticker) {
      results.push({ ticker: `(id: ${asset.id})`, status: "fail", notes: ["ticker 값이 비어 있음"] });
      continue;
    }
    console.log(`- ${asset.ticker} 처리 중...`);
    const result = await collectForAsset(asset.id, asset.ticker);
    results.push(result);
  }

  console.log("\n===== 결과 요약 =====");
  for (const r of results) {
    const label = r.status === "success" ? "[성공]" : r.status === "partial" ? "[일부 성공]" : "[실패]";
    console.log(`${label} ${r.ticker}${r.notes.length ? " — " + r.notes.join(", ") : ""}`);
  }

  const okCount = results.filter((r) => r.status !== "fail").length;
  console.log(`\n${results.length}개 중 ${okCount}개 종목 업데이트 완료.`);
}

main().catch((err) => {
  console.error("스크립트 실행 중 예외가 발생했습니다:", err);
  process.exit(1);
});
