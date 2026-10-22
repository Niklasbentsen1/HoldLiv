// AI-rådgiver til holdoptimering. Grænsefladen gør udbyderen udskiftelig; en mock bruges uden ANTHROPIC_API_KEY.
// Der sendes kun sammentalte tal om hold (antal, alder i år, ventende), aldrig navne eller andre personoplysninger.
export interface AdvisorTeam {
  name: string;
  capacity: number | null;
  players: number;
  waiting: number;
  coaches: number;
  ageMin: number | null;
  ageMax: number | null;
}
export interface AdvisorSuggestion {
  kind: string;
  title: string;
  detail: string;
}
export interface AdvisorInput {
  club: string;
  teams: AdvisorTeam[];
  suggestions: AdvisorSuggestion[];
}
export type Advisor = (input: AdvisorInput) => Promise<string>;

export const mockAdvisor: Advisor = async ({ club, teams, suggestions }) => {
  if (suggestions.length === 0) return `${club}: ingen steder ser holdene presset ud lige nu. Hold øje med ventelisterne.`;
  const top = suggestions.slice(0, 3).map((s, i) => `${i + 1}. ${s.title}`).join("\n");
  return `${club} har ${teams.length} hold og ${suggestions.length} forslag. Start med:\n${top}`;
};

const SYSTEM = `Du er rådgiver for en dansk idrætsforening og hjælper bestyrelsen med at planlægge hold. Du får sammentalte tal om foreningens hold og nogle regelbaserede forslag. Skriv en kort anbefaling på dansk (højst 150 ord): hvad der bør prioriteres først, hvorfor, og hvad der skal afklares. Opfind ikke tal, navne eller fakta ud over det, du får. Svar i almindelig tekst uden markdown.`;

export const anthropicAdvisor: Advisor = async (input) => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    }),
  });
  if (!res.ok) throw new Error(`Rådgiveren svarede ${res.status}`);
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
  if (!text) throw new Error("Rådgiveren gav intet svar");
  return text;
};

export function getAdvisor(): Advisor | null {
  if (process.env.ANTHROPIC_API_KEY) return anthropicAdvisor;
  return process.env.NODE_ENV !== "production" ? mockAdvisor : null;
}
