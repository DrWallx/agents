import {
  DEFAULT_TIMEZONE,
  formatWithPattern,
  roundDownToMinutes,
} from "./time";

// Runtime-owned prompt composition: grounding discipline and safe context-variable interpolation.
// Both are applied by the runtime (prepare.ts), NOT delegated to the tenant's free-text prompt:
// grounding is a product invariant (an un-grounded agent that fabricates answers is the failure
// mode the market punishes), and interpolation values come from the (customer-controlled) contact
// record, so they are sanitized before they ever touch the system prompt (prompt-injection bound).

// Appended to the system prompt whenever the agent is granted the knowledge-base search tool. It
// turns "answer from the KB" into an enforced contract instead of a per-tenant prompting habit.
export const GROUNDING_DIRECTIVE = [
  "Knowledge & grounding rules:",
  "- When the customer asks something answerable from the knowledge base, call search_knowledge FIRST and base your answer ONLY on what it returns.",
  "- Never invent facts, prices, policies, dates, or commitments that are not supported by a search result or by the conversation itself.",
  "- Write a natural reply the customer can read directly: do NOT add reference markers like [1] or footnote-style citations to your answer.",
  "- If the search returns nothing relevant, say plainly that you don't have that information and offer to connect the customer with a human — do NOT guess.",
].join("\n");

export function composeSystemPrompt(
  basePrompt: string,
  opts: { grounded: boolean },
): string {
  const base = basePrompt.trim();
  if (!opts.grounded) return base;
  return base ? `${base}\n\n${GROUNDING_DIRECTIVE}` : GROUNDING_DIRECTIVE;
}

const DETERMINISTIC_POLICY_MARKER =
  "TRAVAS DE REGRESSÃO DA IDENTIFICAÇÃO E RESPOSTA";
const REQUIRED_NAME_REPLY =
  "Para eu cuidar melhor do seu atendimento, qual é o seu nome?";
const URGENT_CUSTOMER_MESSAGE =
  /\b(?:urg[eê]ncia|emerg[eê]ncia|passando mal|efeito colateral|rea[cç][aã]o|falta de ar|desmai|dor (?:forte|intensa)|sangramento)\b/i;
const EXPLICIT_CUSTOMER_NAME =
  /\b(?:meu nome [ée]|sou|pode me chamar de)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,5})/iu;
const PHONE_LIKE_NAME = /^\+?[\d\s().-]{8,}$/;
const KNOWLEDGE_INTERNAL =
  /\b(?:base(?: de dados| de conhecimento)?|rag|banco de dados|sistema|busca)\b/i;
const MISSING_KNOWLEDGE =
  /\b(?:n[aã]o (?:traz|tem|informa|consta|encontr)|sem informa[cç][aã]o|aus[eê]ncia de informa[cç][aã]o)\b/i;
const HANDOFF_PROMISE =
  /\b(?:vou|irei)\s+(?:repassar|encaminhar).{0,160}\bequipe\b|\bequipe\b.{0,160}\b(?:responder|continuar|dar continuidade)\b/is;

export function usesDeterministicResponsePolicy(
  systemPrompt: string,
): boolean {
  return systemPrompt.includes(DETERMINISTIC_POLICY_MARKER);
}

export function isReliableContactName(
  value: string | null | undefined,
): boolean {
  const name = value?.trim() ?? "";
  return !!name && !PHONE_LIKE_NAME.test(name) && /\p{L}/u.test(name);
}

export function explicitNameFromMessage(text: string): string | null {
  return EXPLICIT_CUSTOMER_NAME.exec(text)?.[1]?.trim() ?? null;
}

export function requiredNameReply(params: {
  systemPrompt: string;
  contactName?: string | null;
  customerMessage: string;
}): string | null {
  if (!usesDeterministicResponsePolicy(params.systemPrompt)) return null;
  if (URGENT_CUSTOMER_MESSAGE.test(params.customerMessage)) return null;
  if (isReliableContactName(params.contactName)) return null;
  if (explicitNameFromMessage(params.customerMessage)) return null;
  return REQUIRED_NAME_REPLY;
}

function dedupeRepeatedLines(reply: string): string {
  const lines = reply
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || lines.length % 2 !== 0) return reply.trim();
  const half = lines.length / 2;
  const left = lines.slice(0, half);
  const right = lines.slice(half);
  return left.every((line, index) => line === right[index])
    ? left.join("\n")
    : reply.trim();
}

function removeKnowledgeInternals(reply: string): string {
  const chunks = reply
    .trim()
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const kept = chunks.filter(
    (chunk) =>
      !(KNOWLEDGE_INTERNAL.test(chunk) && MISSING_KNOWLEDGE.test(chunk)),
  );
  if (kept.length === chunks.length) return reply.trim();
  return kept.join("\n").trim();
}

export function applyDeterministicResponsePolicy(params: {
  systemPrompt: string;
  reply: string;
}): { reply: string; requiresHandoff: boolean } {
  if (!usesDeterministicResponsePolicy(params.systemPrompt)) {
    return { reply: params.reply.trim(), requiresHandoff: false };
  }
  const deduped = dedupeRepeatedLines(params.reply);
  const reply = removeKnowledgeInternals(deduped) || deduped;
  return { reply, requiresHandoff: HANDOFF_PROMISE.test(reply) };
}

// ── context variables ──

export interface PromptVarContext {
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  inboxName?: string | null;
  // Operator-controlled (trusted) identity values.
  companyName?: string | null;
  agentName?: string | null;
}

export const VALUE_MAX = 120;

// NOTE: Contact/inbox values are customer-controlled → drop control chars and newlines (so a value
// can never forge multi-line "system" framing in the prompt), collapse whitespace, and bound length.
// Exported as sanitizePromptValue because every OTHER customer-controlled string we splice into the
// system prompt (e.g. the Chatwoot attribute values) must go through the same treatment. `max` is
// per-caller: VALUE_MAX suits identity variables, but a stored attribute (an address, a note) is
// legitimately longer — see ATTRIBUTE_VALUE_MAX in chatwoot/attributes.ts.
export function sanitizePromptValue(
  v: string | null | undefined,
  max: number = VALUE_MAX,
): string {
  if (!v) return "";
  let out = "";
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    // NOTE: C0 + DEL + C1. The C1 range matters as much as C0 and is easy to miss: U+0085 (NEL) is
    // a line break to plenty of renderers and tokenizers, and JS `\s` does NOT match it, so the
    // collapse below would let it through and a value could still forge a new line of framing.
    const control =
      code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += control ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

// Placeholder → value. English canonical names plus the common pt-BR aliases the audience writes.
export function buildPromptVars(ctx: PromptVarContext): Record<string, string> {
  const name = sanitizePromptValue(ctx.contactName);
  const firstName = name.split(" ")[0] ?? "";
  const email = sanitizePromptValue(ctx.contactEmail);
  const phone = sanitizePromptValue(ctx.contactPhone);
  const inbox = sanitizePromptValue(ctx.inboxName);
  const company = sanitizePromptValue(ctx.companyName);
  const agent = sanitizePromptValue(ctx.agentName);
  return {
    contact_name: name,
    nome_contato: name,
    contact_first_name: firstName,
    primeiro_nome: firstName,
    contact_email: email,
    email_contato: email,
    contact_phone: phone,
    telefone_contato: phone,
    inbox_name: inbox,
    canal: inbox,
    company_name: company,
    nome_empresa: company,
    agent_name: agent,
    nome_agente: agent,
  };
}

// Default rounding slot for the "current time" variables: floors to the half hour so the injected
// value is stable within a 30-min window (prompt caching), unless the operator asks for the exact
// variant. Time variables map name → { rounded, defaultFormat, roundedSibling? }; the {{var:FORMAT}}
// suffix (using formatWithPattern tokens YYYY/MM/DD/HH/mm/ss) overrides the format, never the rounding.
export const TIME_ROUND_MINUTES = 30;
const TIME_VARS: Record<
  string,
  { rounded: boolean; defaultFormat: string; roundedSibling?: string }
> = {
  hora_atual: { rounded: true, defaultFormat: "HH:mm" },
  current_time: { rounded: true, defaultFormat: "HH:mm" },
  // Exact time-of-day vars: the value changes every minute, defeating prompt caching. roundedSibling
  // names the cache-stable variant the editor suggests instead.
  hora_atual_exata: {
    rounded: false,
    defaultFormat: "HH:mm",
    roundedSibling: "hora_atual",
  },
  current_time_exact: {
    rounded: false,
    defaultFormat: "HH:mm",
    roundedSibling: "current_time",
  },
  data_atual: { rounded: false, defaultFormat: "DD/MM/YYYY" },
  current_date: { rounded: false, defaultFormat: "DD/MM/YYYY" },
  data_hora_atual: { rounded: true, defaultFormat: "DD/MM/YYYY HH:mm" },
  current_datetime: { rounded: true, defaultFormat: "DD/MM/YYYY HH:mm" },
};

// {{ var }} or {{ var:FORMAT }} — spaces optional, var is lowercase + underscores, format is any
// run of non-`}` chars. Single-brace {x} is intentionally NOT matched (clean migration). Exported
// as a source string (build a fresh RegExp per use — the global flag carries lastIndex) so the
// editor's syntax highlighter marks exactly what the runtime will interpolate.
export const PROMPT_PLACEHOLDER_SOURCE =
  "\\{\\{\\s*([a-z_]+)(?::([^}]+))?\\s*\\}\\}";
const PLACEHOLDER = new RegExp(PROMPT_PLACEHOLDER_SOURCE, "g");

// Replaces ONLY allowlisted {{placeholders}}; an unknown one is left untouched (the tenant sees its
// own literal, never a leak/empty). Static values are pre-sanitized by buildPromptVars; time
// variables are computed from `opts.now` (default: real now) in `opts.timezone`.
export function interpolatePromptVars(
  template: string,
  vars: Record<string, string>,
  opts: {
    timezone?: string;
    now?: Date;
    // Called for every successfully-resolved placeholder (context or time var) with the resolved
    // value and the variable name; its return replaces the value. Defaults to identity. Unknown
    // placeholders are left untouched and never wrapped. The preview uses it to mark dynamic text.
    wrap?: (resolved: string, name: string) => string;
  } = {},
): string {
  const wrap = opts.wrap ?? ((v: string) => v);
  return template.replace(
    PLACEHOLDER,
    (match, key: string, fmt: string | undefined) => {
      const timeVar = TIME_VARS[key];
      if (timeVar) {
        const tz = opts.timezone || DEFAULT_TIMEZONE;
        const now = opts.now ?? new Date();
        const when = timeVar.rounded
          ? roundDownToMinutes(now, TIME_ROUND_MINUTES)
          : now;
        return wrap(
          formatWithPattern(when, tz, fmt?.trim() || timeVar.defaultFormat),
          key,
        );
      }
      return key in vars ? wrap(vars[key] as string, key) : match;
    },
  );
}

// All interpolatable time-variable names (incl. EN aliases). Used internally for the known-var set;
// the editor's "insert variable" helper shows the deduped pt-BR subset (PROMPT_TIME_VARS_DISPLAY).
export const PROMPT_TIME_VARS = Object.keys(TIME_VARS);

// Canonical pt-BR time vars shown in the editor's "insert variable" helper. Interpolation still
// accepts the EN aliases (current_time/current_date/…) for compat, but listing both names side by
// side just confused operators ("current_time vs hora_atual?"). One name per concept here.
export const PROMPT_TIME_VARS_DISPLAY = [
  "hora_atual",
  "hora_atual_exata",
  "data_atual",
  "data_hora_atual",
];

export const PROMPT_CONTEXT_VARS = [
  "nome_empresa",
  "nome_agente",
  "nome_contato",
  "primeiro_nome",
  "email_contato",
  "telefone_contato",
  "canal",
];

// Every interpolatable name (time vars + both EN/pt-BR context aliases), so the editor's syntax
// highlighter can tell a real {{var}} from a typo. Derived from the same sources the runtime uses.
const PROMPT_ALL_VARS = new Set<string>([
  ...PROMPT_TIME_VARS,
  ...Object.keys(buildPromptVars({})),
]);

export function isKnownPromptVar(name: string): boolean {
  return PROMPT_ALL_VARS.has(name);
}

// ── rounding / caching helpers (editor UI) ──

// Classifies a display time var for the editor's help tooltip: "rounded" (floored to the slot, stable
// across requests → good for prompt caching), "exact" (time-of-day recomputed every minute → defeats
// caching), or "date" (date-only, stable within a day). null for non-time vars. Derived from TIME_VARS
// so the tooltip never drifts from the runtime.
export type TimeVarKind = "rounded" | "exact" | "date";
export function timeVarKind(name: string): TimeVarKind | null {
  const v = TIME_VARS[name];
  if (!v) return null;
  if (v.rounded) return "rounded";
  return v.roundedSibling ? "exact" : "date";
}

// Scans a prompt template for exact time-of-day vars (cache-volatile) and returns each distinct one
// with the rounded sibling to suggest. Empty when there is nothing to warn about. Powers the editor's
// "prefer the rounded variable" caching hint.
export function findExactTimeVarUsages(
  template: string,
): Array<{ name: string; suggestion: string }> {
  const re = new RegExp(PROMPT_PLACEHOLDER_SOURCE, "g");
  const seen = new Set<string>();
  const out: Array<{ name: string; suggestion: string }> = [];
  for (const m of template.matchAll(re)) {
    const name = m[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const sibling = TIME_VARS[name]?.roundedSibling;
    if (sibling) out.push({ name, suggestion: sibling });
  }
  return out;
}
