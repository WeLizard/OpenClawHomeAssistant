import fs from "node:fs/promises";
import path from "node:path";

type AssistantHaEntityMap = {
  online: string;
  busy: string;
  status: string;
  message: string;
  source: string;
  updatedAt: string;
  emotion: string;
  activity: string;
  cue: string;
  speaking: string;
  intensity: string;
  motion: string;
  revision: string;
};

type AssistantHaControlEntityMap = {
  viewPreset?: string;
  pageMode?: string;
  pageTarget?: string;
  pageUntil?: string;
  cue?: string;
  emotion?: string;
  motion?: string;
  cueUntil?: string;
  revision?: string;
};

type PersistedControlState = {
  version: 1;
  revision: number;
  viewPreset: "full" | "torso" | "head" | null;
  page: {
    mode: "auto" | "pinned";
    target: string | null;
    until: string | null;
  };
  cue: {
    cue: string | null;
    emotion: string | null;
    motion: string | null;
    until: string | null;
  };
};

const DEFAULT_STATE_FILES = [
  "/config/www/live2d/neiri-state.json",
  "/homeassistant/www/live2d/neiri-state.json",
  "/data/homeassistant/www/live2d/neiri-state.json",
  "/mnt/data/supervisor/homeassistant/www/live2d/neiri-state.json",
];
const STATE_FILES = [
  ...DEFAULT_STATE_FILES,
  ...readCsvEnv("OPENCLAW_ASSISTANT_STATE_FILES", "NEIRI_STATE_FILES"),
];
const DEFAULT_CONTROL_FILES = [
  "/config/www/live2d/neiri-control.json",
  "/homeassistant/www/live2d/neiri-control.json",
  "/data/homeassistant/www/live2d/neiri-control.json",
  "/mnt/data/supervisor/homeassistant/www/live2d/neiri-control.json",
];
const CONTROL_FILES = [
  ...DEFAULT_CONTROL_FILES,
  ...readCsvEnv("OPENCLAW_ASSISTANT_CONTROL_FILES", "NEIRI_CONTROL_FILES"),
];
const SESSION_STORE_FILES = [
  "/config/.openclaw/agents/main/sessions/sessions.json",
  "/homeassistant/.openclaw/agents/main/sessions/sessions.json",
];
const MAIN_SESSION_KEY = "agent:main:main";
const TRANSCRIPT_POLL_MS = 1500;
const TRANSCRIPT_TAIL_BYTES = 262144;
const SPEECH_SETTLE_MIN_MS = 8000;
const SPEECH_SETTLE_MAX_MS = 22000;
const SPEECH_SETTLE_PER_CHAR_MS = 85;
const ASSISTANT_NAME = cleanText(
  process.env.OPENCLAW_ASSISTANT_NAME ?? process.env.NEIRI_ASSISTANT_NAME ?? "Нейри",
  40,
) || "Нейри";
const HA_BASE_URL_ENV = cleanText(
  process.env.OPENCLAW_ASSISTANT_HA_URL ?? process.env.NEIRI_HA_URL,
  1024,
);
const HA_BASE_URL_FALLBACKS = [
  "http://homeassistant:8123",
  "http://homeassistant.local:8123",
  "http://localhost:8123",
];
const HA_TOKEN_FILE = "/config/secrets/homeassistant.token";
const HA_TIMEOUT_MS = 5000;
const DEFAULT_HA_ENTITIES: AssistantHaEntityMap = {
  online: "input_boolean.neiri_online",
  busy: "input_boolean.neiri_busy",
  status: "input_text.neiri_status",
  message: "input_text.neiri_message",
  source: "input_text.neiri_source",
  updatedAt: "input_text.neiri_updated_at",
  emotion: "input_text.neiri_emotion",
  activity: "input_text.neiri_activity",
  cue: "input_text.neiri_cue",
  speaking: "input_boolean.neiri_speaking",
  intensity: "input_number.neiri_intensity",
  motion: "input_text.neiri_motion",
  revision: "input_number.neiri_revision",
};
const HA_ENTITIES = resolveHaEntities();
const DEFAULT_HA_CONTROL_ENTITIES: AssistantHaControlEntityMap = {
  viewPreset: "input_text.neiri_view_preset",
  pageMode: "input_text.neiri_page_mode",
  pageTarget: "input_text.neiri_page_target",
  pageUntil: "input_text.neiri_page_until",
  revision: "input_number.neiri_control_revision",
};
const HA_CONTROL_ENTITIES = resolveHaControlEntities();
const DEFAULT_CONTROL_STATE: PersistedControlState = {
  version: 1,
  revision: 0,
  viewPreset: null,
  page: {
    mode: "auto",
    target: null,
    until: null,
  },
  cue: {
    cue: null,
    emotion: null,
    motion: null,
    until: null,
  },
};

let haTokenPromise: Promise<string> | null = null;
let resolvedHaBaseUrl = "";
let transcriptPollTimer: ReturnType<typeof setInterval> | null = null;
let transcriptPollInFlight = false;
let transcriptPrimed = false;
let lastTranscriptSessionFile = "";
let lastTranscriptSignature = "";
let speechSettleTimer: ReturnType<typeof setTimeout> | null = null;

function readCsvEnv(...names: string[]) {
  return names
    .map((name) => process.env[name] ?? "")
    .flatMap((raw) => raw.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function readNamedEnv(...names: string[]) {
  for (const name of names) {
    const value = cleanText(process.env[name], 4096);
    if (value) {
      return value;
    }
  }
  return "";
}

function sanitizeIntensity(value: unknown) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return clampNumber(numeric, 0, 1);
}

function sanitizeEntityMapOverride(value: unknown) {
  if (!isObjectRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [cleanText(key, 32), cleanText(entryValue, 255)])
      .filter(([key, entryValue]) => key && entryValue),
  );
}

function resolveHaEntities(): AssistantHaEntityMap {
  const jsonOverrideRaw = readNamedEnv("OPENCLAW_ASSISTANT_HA_ENTITY_MAP", "NEIRI_HA_ENTITY_MAP");
  let jsonOverride: Record<string, string> = {};
  if (jsonOverrideRaw) {
    try {
      jsonOverride = sanitizeEntityMapOverride(JSON.parse(jsonOverrideRaw));
    } catch {
      jsonOverride = {};
    }
  }

  const fieldEnv = (field: keyof AssistantHaEntityMap) =>
    readNamedEnv(
      `OPENCLAW_ASSISTANT_HA_ENTITY_${String(field).toUpperCase()}`,
      `NEIRI_HA_ENTITY_${String(field).toUpperCase()}`,
    );

  return {
    online: fieldEnv("online") || jsonOverride.online || DEFAULT_HA_ENTITIES.online,
    busy: fieldEnv("busy") || jsonOverride.busy || DEFAULT_HA_ENTITIES.busy,
    status: fieldEnv("status") || jsonOverride.status || DEFAULT_HA_ENTITIES.status,
    message: fieldEnv("message") || jsonOverride.message || DEFAULT_HA_ENTITIES.message,
    source: fieldEnv("source") || jsonOverride.source || DEFAULT_HA_ENTITIES.source,
    updatedAt: fieldEnv("updatedAt") || jsonOverride.updatedAt || DEFAULT_HA_ENTITIES.updatedAt,
    emotion: fieldEnv("emotion") || jsonOverride.emotion || DEFAULT_HA_ENTITIES.emotion,
    activity: fieldEnv("activity") || jsonOverride.activity || DEFAULT_HA_ENTITIES.activity,
    cue: fieldEnv("cue") || jsonOverride.cue || DEFAULT_HA_ENTITIES.cue,
    speaking: fieldEnv("speaking") || jsonOverride.speaking || DEFAULT_HA_ENTITIES.speaking,
    intensity: fieldEnv("intensity") || jsonOverride.intensity || DEFAULT_HA_ENTITIES.intensity,
    motion: fieldEnv("motion") || jsonOverride.motion || DEFAULT_HA_ENTITIES.motion,
    revision: fieldEnv("revision") || jsonOverride.revision || DEFAULT_HA_ENTITIES.revision,
  };
}

function resolveHaControlEntities(): AssistantHaControlEntityMap {
  const jsonOverrideRaw = readNamedEnv(
    "OPENCLAW_ASSISTANT_HA_CONTROL_ENTITY_MAP",
    "NEIRI_HA_CONTROL_ENTITY_MAP",
  );
  let jsonOverride: Record<string, string> = {};
  if (jsonOverrideRaw) {
    try {
      jsonOverride = sanitizeEntityMapOverride(JSON.parse(jsonOverrideRaw));
    } catch {
      jsonOverride = {};
    }
  }

  const fieldEnv = (field: keyof AssistantHaControlEntityMap) =>
    readNamedEnv(
      `OPENCLAW_ASSISTANT_HA_CONTROL_ENTITY_${String(field).toUpperCase()}`,
      `NEIRI_HA_CONTROL_ENTITY_${String(field).toUpperCase()}`,
    );

  return {
    viewPreset: fieldEnv("viewPreset") || jsonOverride.viewPreset || DEFAULT_HA_CONTROL_ENTITIES.viewPreset,
    pageMode: fieldEnv("pageMode") || jsonOverride.pageMode || DEFAULT_HA_CONTROL_ENTITIES.pageMode,
    pageTarget: fieldEnv("pageTarget") || jsonOverride.pageTarget || DEFAULT_HA_CONTROL_ENTITIES.pageTarget,
    pageUntil: fieldEnv("pageUntil") || jsonOverride.pageUntil || DEFAULT_HA_CONTROL_ENTITIES.pageUntil,
    cue: fieldEnv("cue") || jsonOverride.cue || DEFAULT_HA_CONTROL_ENTITIES.cue,
    emotion: fieldEnv("emotion") || jsonOverride.emotion || DEFAULT_HA_CONTROL_ENTITIES.emotion,
    motion: fieldEnv("motion") || jsonOverride.motion || DEFAULT_HA_CONTROL_ENTITIES.motion,
    cueUntil: fieldEnv("cueUntil") || jsonOverride.cueUntil || DEFAULT_HA_CONTROL_ENTITIES.cueUntil,
    revision: fieldEnv("revision") || jsonOverride.revision || DEFAULT_HA_CONTROL_ENTITIES.revision,
  };
}

function clearSpeechSettleTimer() {
  if (speechSettleTimer) {
    clearTimeout(speechSettleTimer);
    speechSettleTimer = null;
  }
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function speechSettleDelayMs(message: string) {
  const text = cleanText(message, 220);
  if (!text) {
    return SPEECH_SETTLE_MIN_MS;
  }

  return clampNumber(
    text.length * SPEECH_SETTLE_PER_CHAR_MS + 2500,
    SPEECH_SETTLE_MIN_MS,
    SPEECH_SETTLE_MAX_MS,
  );
}

function uniqueStateFiles() {
  return Array.from(new Set(STATE_FILES.map((file) => path.normalize(file))));
}

function uniqueControlFiles() {
  return Array.from(new Set(CONTROL_FILES.map((file) => path.normalize(file))));
}

function uniqueSessionStoreFiles() {
  return Array.from(new Set(SESSION_STORE_FILES.map((file) => path.normalize(file))));
}

function uniqueHaBaseUrls() {
  return Array.from(
    new Set([resolvedHaBaseUrl, HA_BASE_URL_ENV, ...HA_BASE_URL_FALLBACKS].filter(Boolean)),
  );
}

function normalizeViewPreset(value: unknown): PersistedControlState["viewPreset"] {
  const normalized = cleanText(value, 16).toLowerCase();
  if (normalized === "full" || normalized === "torso" || normalized === "head") {
    return normalized;
  }
  return null;
}

function normalizeControlMode(value: unknown): PersistedControlState["page"]["mode"] {
  return cleanText(value, 16).toLowerCase() === "pinned" ? "pinned" : "auto";
}

function getControlRevision(control: unknown) {
  const revision = Number(isObjectRecord(control) ? control.revision : undefined);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function normalizePersistedControlState(value: unknown): PersistedControlState {
  const control = isObjectRecord(value) ? value : {};
  const page = isObjectRecord(control.page) ? control.page : {};
  const cue = isObjectRecord(control.cue) ? control.cue : {};
  const pageTarget = cleanText(page.target, 40) || null;
  const pageMode = normalizeControlMode(page.mode);

  return {
    version: 1,
    revision: getControlRevision(control),
    viewPreset: normalizeViewPreset(control.viewPreset),
    page: pageMode === "pinned" && pageTarget
      ? {
          mode: "pinned",
          target: pageTarget,
          until: cleanText(page.until, 64) || null,
        }
      : {
          mode: "auto",
          target: null,
          until: null,
        },
    cue: {
      cue: cleanText(cue.cue, 32) || null,
      emotion: cleanText(cue.emotion, 32) || null,
      motion: cleanText(cue.motion, 32) || null,
      until: cleanText(cue.until, 64) || null,
    },
  };
}

function createRuntimeEvent(type: string, action: string) {
  return {
    type,
    action,
    timestamp: new Date(),
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readState() {
  const states = await Promise.all(uniqueStateFiles().map((filePath) => readJson(filePath)));
  const candidates = states.filter((state) => state && typeof state === "object");
  if (candidates.length === 0) {
    return {};
  }
  candidates.sort((a, b) => getRevision(b) - getRevision(a));
  return candidates[0] || {};
}

async function readControl() {
  const controls = await Promise.all(uniqueControlFiles().map((filePath) => readJson(filePath)));
  const candidates = controls.filter((control) => control && typeof control === "object");
  if (candidates.length === 0) {
    return { ...DEFAULT_CONTROL_STATE };
  }
  candidates.sort((a, b) => getControlRevision(b) - getControlRevision(a));
  return normalizePersistedControlState(candidates[0]);
}

function cleanText(value: unknown, maxLength = 200) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeAvatarText(value: unknown, maxLength = 220) {
  if (typeof value !== "string") {
    return "";
  }

  let text = value;
  text = text.replace(/\[media attached:[\s\S]*?\]/gi, " ");
  text = text.replace(/<media:[^>]+>/gi, " ");
  text = text.replace(
    /To send an image back,[\s\S]*?(?=(Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):|$))/gi,
    " ",
  );
  text = text.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi, " ");
  text = text.replace(/Sender \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi, " ");
  text = text.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?>>>/gi, " ");
  text = text.replace(/SECURITY NOTICE:[\s\S]*?(?=<<<|$)/gi, " ");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/\[\[reply_to_current\]\]/gi, " ");

  return cleanText(text, maxLength);
}

function normalizeErrorText(value: unknown) {
  const raw = cleanText(value, 280);
  const lower = raw.toLowerCase();
  if (!raw) {
    return "";
  }

  if (lower.includes("no endpoints found that support tool use")) {
    return "Модель не поддерживает tool use. Нужна другая fallback-модель.";
  }
  if (lower.includes("401 user not found")) {
    return "OpenRouter: аккаунт не найден (401).";
  }
  if (lower.includes("403 forbidden")) {
    return "Провайдер модели отклонил запрос (403).";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "Провайдер временно ограничил запросы (429).";
  }

  return sanitizeAvatarText(raw, 220);
}

function containsAny(text: string, needles: string[]) {
  if (!text || !Array.isArray(needles) || needles.length === 0) {
    return false;
  }
  return needles.some((needle) => Boolean(needle) && text.includes(needle));
}

function inferAvatarCue(
  textValue: unknown,
  options?: { isError?: boolean; busy?: boolean; status?: string },
) {
  const text = cleanText(textValue, 280);
  const lower = text.toLowerCase();
  const status = cleanText(options?.status, 120).toLowerCase();
  const full = `${status} ${lower}`.trim();
  const emphatic = /[!！]{2,}/.test(text);

  if (options?.busy) {
    return { cue: "think", motion: "think", emotion: "think", activity: "thinking", speaking: false, intensity: 0.45 };
  }

  if (
    options?.isError ||
    containsAny(full, [
      "ошибка",
      "error",
      "forbidden",
      "rate limit",
      "429",
      "не удалось",
      "не могу",
      "отклон",
      "недоступ",
      "таймаут",
      "сбой",
    ])
  ) {
    return { cue: "error", motion: "error", emotion: "error", activity: "error", speaking: false, intensity: 0.9 };
  }

  if (containsAny(full, ["предупреж", "внимание", "осторож", "ай-яй", "ай ай", "аккуратн"])) {
    return { cue: "warning", motion: "warning", emotion: "warning", activity: "speaking", speaking: true, intensity: 0.72 };
  }

  if (containsAny(full, ["не уверен", "растер", "пута", "непонят", "confused", "unknown", "хм..."])) {
    return { cue: "confused", motion: "confused", emotion: "confused", activity: "speaking", speaking: true, intensity: 0.62 };
  }

  if (containsAny(full, ["не буду", "отказываюсь", "нельзя", "запрещено", "не могу помочь с этим"])) {
    return { cue: "refuse", motion: "refuse", emotion: "refuse", activity: "speaking", speaking: true, intensity: 0.74 };
  }

  if (containsAny(full, ["спасибо", "готово", "сделано", "получилось", "умнич", "подтверждаю", "успех"])) {
    return { cue: "approve", motion: "approve", emotion: "approve", activity: "speaking", speaking: true, intensity: 0.66 };
  }

  if (containsAny(full, ["как и ожидал", "я же говорила", "предсказуемо", "понятно же"])) {
    return { cue: "reply_dry", motion: "reply_dry", emotion: "reply_dry", activity: "speaking", speaking: true, intensity: 0.54 };
  }

  if (containsAny(full, ["думаю", "анализир", "считаю", "проверяю", "ищу", "подожди"])) {
    return { cue: "think", motion: "think", emotion: "think", activity: "thinking", speaking: false, intensity: 0.45 };
  }

  if (containsAny(full, ["ой", "ого", "вау", "неожиданно", "удивительно"])) {
    return { cue: "surprise", motion: "surprise", emotion: "surprise", activity: "speaking", speaking: true, intensity: 0.82 };
  }

  if (containsAny(full, ["мяу", "ня", "милаш", "милота", "няш", "обнял", "обним", "лапушка", "котик"])) {
    return { cue: "cute", motion: "cute", emotion: "cute", activity: "speaking", speaking: true, intensity: 0.68 };
  }

  if (containsAny(full, ["извини", "прости", "смущ", "стесня", "неудобно"])) {
    return { cue: "shy", motion: "shy", emotion: "shy", activity: "speaking", speaking: true, intensity: 0.52 };
  }

  if (containsAny(full, ["ура", "класс", "супер", "отлично", "замечательно", "круто"]) || emphatic) {
    return { cue: "reply_excited", motion: "reply_excited", emotion: "reply_excited", activity: "speaking", speaking: true, intensity: 0.8 };
  }

  if (text.includes("?")) {
    return { cue: "reply_soft", motion: "reply_soft", emotion: "reply_soft", activity: "speaking", speaking: true, intensity: 0.58 };
  }

  if (text.length > 0 && text.length <= 60) {
    return { cue: "reply_soft", motion: "reply_soft", emotion: "reply_soft", activity: "speaking", speaking: true, intensity: 0.56 };
  }

  if (text.length > 0) {
    return { cue: "reply", motion: "reply", emotion: "reply", activity: "speaking", speaking: true, intensity: 0.64 };
  }

  return { cue: "calm", motion: "calm", emotion: "calm", activity: "idle", speaking: false, intensity: 0.12 };
}

function getRevision(state: unknown) {
  const revision = Number(isObjectRecord(state) ? state.revision : undefined);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

async function writeStateToFile(filePath: string, nextState: Record<string, unknown>) {
  const stateDir = path.dirname(filePath);
  await fs.mkdir(stateDir, { recursive: true });
  const tempFile = path.join(stateDir, `.neiri-state.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
  await fs.rename(tempFile, filePath);
}

async function writeControlToFile(filePath: string, nextControl: PersistedControlState) {
  const controlDir = path.dirname(filePath);
  await fs.mkdir(controlDir, { recursive: true });
  const tempFile = path.join(controlDir, `.neiri-control.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempFile, `${JSON.stringify(nextControl, null, 2)}\n`, "utf-8");
  await fs.rename(tempFile, filePath);
}

async function writeState(nextState: Record<string, unknown>) {
  const targets = uniqueStateFiles();
  const results = await Promise.allSettled(
    targets.map((filePath) => writeStateToFile(filePath, nextState)),
  );
  const successCount = results.filter((entry) => entry.status === "fulfilled").length;
  const failures = results
    .map((entry, index) => (entry.status === "rejected" ? `${targets[index]}: ${String(entry.reason)}` : null))
    .filter(Boolean)
    .join("; ");
  if (successCount === 0) {
    throw new Error(failures || "Failed to write assistant state to all targets");
  }
  if (failures) {
    console.warn(`[neiri-avatar-state] state write partial failure: ${failures}`);
  }
}

async function writeControl(nextControl: PersistedControlState) {
  const targets = uniqueControlFiles();
  const results = await Promise.allSettled(
    targets.map((filePath) => writeControlToFile(filePath, nextControl)),
  );
  const successCount = results.filter((entry) => entry.status === "fulfilled").length;
  const failures = results
    .map((entry, index) => (entry.status === "rejected" ? `${targets[index]}: ${String(entry.reason)}` : null))
    .filter(Boolean)
    .join("; ");
  if (successCount === 0) {
    throw new Error(failures || "Failed to write assistant control to all targets");
  }
  if (failures) {
    console.warn(`[neiri-avatar-state] control write partial failure: ${failures}`);
  }
}

async function readHaToken() {
  if (!haTokenPromise) {
    haTokenPromise = fs
      .readFile(HA_TOKEN_FILE, "utf-8")
      .then((raw) => raw.trim())
      .then((token) => {
        if (!token) {
          throw new Error("homeassistant token is empty");
        }
        return token;
      })
      .catch((error) => {
        haTokenPromise = null;
        throw error;
      });
  }
  return haTokenPromise;
}

async function callHaService(domain: string, service: string, payload: Record<string, unknown>) {
  const token = await readHaToken();
  const attempts: string[] = [];
  for (const baseUrl of uniqueHaBaseUrls()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HA_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/services/${domain}/${service}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        attempts.push(`${baseUrl} -> HTTP ${response.status}${details ? ` ${details}` : ""}`);
        continue;
      }

      if (resolvedHaBaseUrl !== baseUrl) {
        resolvedHaBaseUrl = baseUrl;
        console.info(`[neiri-avatar-state] using HA API at ${baseUrl}`);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(`${baseUrl} -> ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${domain}.${service} failed: ${attempts.join(" | ") || "no HA endpoints available"}`);
}

async function publishToHomeAssistant(state: Record<string, unknown>) {
  const tasks = [
    callHaService("input_boolean", state.online ? "turn_on" : "turn_off", { entity_id: HA_ENTITIES.online }),
    callHaService("input_boolean", state.busy ? "turn_on" : "turn_off", { entity_id: HA_ENTITIES.busy }),
    callHaService("input_boolean", state.speaking ? "turn_on" : "turn_off", { entity_id: HA_ENTITIES.speaking }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.status,
      value: cleanText(state.status, 255),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.message,
      value: cleanText(state.message, 255),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.source,
      value: cleanText(state.source, 64),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.updatedAt,
      value: cleanText(state.updatedAt, 64),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.emotion,
      value: cleanText(state.emotion, 64),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.activity,
      value: cleanText(state.activity, 64),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.cue,
      value: cleanText(state.cue, 64),
    }),
    callHaService("input_text", "set_value", {
      entity_id: HA_ENTITIES.motion,
      value: cleanText(state.motion, 64),
    }),
    callHaService("input_number", "set_value", {
      entity_id: HA_ENTITIES.intensity,
      value: sanitizeIntensity(state.intensity) ?? 0,
    }),
    callHaService("input_number", "set_value", {
      entity_id: HA_ENTITIES.revision,
      value: getRevision(state),
    }),
  ];

  const results = await Promise.allSettled(tasks);
  const failures = results
    .map((result) => (result.status === "rejected" ? String(result.reason) : null))
    .filter(Boolean);

  if (failures.length > 0) {
    console.warn(`[neiri-avatar-state] HA publish partial failure: ${failures.join("; ")}`);
  }
}

async function publishControlToHomeAssistant(control: PersistedControlState) {
  const tasks = [];
  if (HA_CONTROL_ENTITIES.viewPreset) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.viewPreset,
      value: cleanText(control.viewPreset, 32),
    }));
  }
  if (HA_CONTROL_ENTITIES.pageMode) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.pageMode,
      value: cleanText(control.page.mode, 32),
    }));
  }
  if (HA_CONTROL_ENTITIES.pageTarget) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.pageTarget,
      value: cleanText(control.page.target, 64),
    }));
  }
  if (HA_CONTROL_ENTITIES.pageUntil) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.pageUntil,
      value: cleanText(control.page.until, 64),
    }));
  }
  if (HA_CONTROL_ENTITIES.cue) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.cue,
      value: cleanText(control.cue.cue, 64),
    }));
  }
  if (HA_CONTROL_ENTITIES.emotion) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.emotion,
      value: cleanText(control.cue.emotion, 64),
    }));
  }
  if (HA_CONTROL_ENTITIES.motion) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.motion,
      value: cleanText(control.cue.motion, 64),
    }));
  }
  if (HA_CONTROL_ENTITIES.cueUntil) {
    tasks.push(callHaService("input_text", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.cueUntil,
      value: cleanText(control.cue.until, 64),
    }));
  }
  if (HA_CONTROL_ENTITIES.revision) {
    tasks.push(callHaService("input_number", "set_value", {
      entity_id: HA_CONTROL_ENTITIES.revision,
      value: getControlRevision(control),
    }));
  }

  const results = await Promise.allSettled(tasks);
  const failures = results
    .map((result) => (result.status === "rejected" ? String(result.reason) : null))
    .filter(Boolean);

  if (failures.length > 0) {
    console.warn(`[neiri-avatar-state] HA control publish partial failure: ${failures.join("; ")}`);
  }
}

async function persistState(
  event: { type: string; action: string; timestamp?: Date } | null,
  patch: Record<string, unknown>,
) {
  const previous = await readState();
  const eventKey = event ? `${event.type}:${event.action}` : "runtime:update";
  const nextState = {
    version: 1,
    assistant: ASSISTANT_NAME,
    online: patch.online ?? (typeof previous.online === "boolean" ? previous.online : true),
    busy: patch.busy ?? Boolean(previous.busy),
    status:
      patch.status ??
      (typeof previous.status === "string" && previous.status.trim() ? previous.status : "На связи"),
    message: patch.message ?? (typeof previous.message === "string" ? previous.message : ""),
    source:
      patch.source ??
      (typeof previous.source === "string" && previous.source.trim() ? previous.source : "system"),
    updatedAt:
      event?.timestamp && typeof event.timestamp.toISOString === "function"
        ? event.timestamp.toISOString()
        : new Date().toISOString(),
    emotion: cleanText(patch.emotion, 32) || cleanText(previous.emotion, 32),
    activity: cleanText(patch.activity, 32) || cleanText(previous.activity, 32),
    cue: cleanText(patch.cue, 32) || cleanText(previous.cue, 32),
    intensity: sanitizeIntensity(patch.intensity ?? previous.intensity),
    speaking: typeof patch.speaking === "boolean" ? patch.speaking : Boolean(previous.speaking),
    motion: cleanText(patch.motion, 32) || cleanText(previous.motion, 32),
    revision: getRevision(previous) + 1,
    event: eventKey,
  };

  await writeState(nextState);
  await publishToHomeAssistant(nextState).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[neiri-avatar-state] ${message}`);
  });
}

function controlStateSignature(control: PersistedControlState) {
  return JSON.stringify({
    viewPreset: control.viewPreset,
    page: control.page,
    cue: control.cue,
  });
}

async function persistControl(
  patch: {
    viewPreset?: PersistedControlState["viewPreset"];
    page?: Partial<PersistedControlState["page"]>;
    cue?: Partial<PersistedControlState["cue"]>;
  },
) {
  const previous = normalizePersistedControlState(await readControl());

  let nextViewPreset = previous.viewPreset;
  if (patch.viewPreset !== undefined) {
    nextViewPreset = normalizeViewPreset(patch.viewPreset);
  }

  let nextPage = { ...previous.page };
  if (patch.page) {
    const requestedMode = normalizeControlMode(patch.page.mode ?? previous.page.mode);
    const requestedTarget = cleanText(
      patch.page.target !== undefined ? patch.page.target : previous.page.target,
      40,
    ) || null;
    const requestedUntil = cleanText(
      patch.page.until !== undefined ? patch.page.until : previous.page.until,
      64,
    ) || null;
    nextPage = requestedMode === "pinned" && requestedTarget
      ? {
          mode: "pinned",
          target: requestedTarget,
          until: requestedUntil,
        }
      : {
          mode: "auto",
          target: null,
          until: null,
        };
  }

  let nextCue = { ...previous.cue };
  if (patch.cue) {
    nextCue = {
      cue: cleanText(patch.cue.cue !== undefined ? patch.cue.cue : previous.cue.cue, 32) || null,
      emotion: cleanText(patch.cue.emotion !== undefined ? patch.cue.emotion : previous.cue.emotion, 32) || null,
      motion: cleanText(patch.cue.motion !== undefined ? patch.cue.motion : previous.cue.motion, 32) || null,
      until: cleanText(patch.cue.until !== undefined ? patch.cue.until : previous.cue.until, 64) || null,
    };
  }

  const nextControl: PersistedControlState = {
    version: 1,
    revision: previous.revision,
    viewPreset: nextViewPreset,
    page: nextPage,
    cue: nextCue,
  };

  if (controlStateSignature(previous) === controlStateSignature(nextControl)) {
    return previous;
  }

  nextControl.revision = previous.revision + 1;
  await writeControl(nextControl);
  await publishControlToHomeAssistant(nextControl).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[neiri-avatar-state] ${message}`);
  });
  return nextControl;
}

async function settleSpeechState(reason: string) {
  const latest = await readState();
  const currentMessage = cleanText(latest.message, 220);
  const currentStatus = cleanText(latest.status, 64);
  if (!currentMessage || latest.busy) {
    return;
  }

  if (currentStatus !== "Говорю" && currentStatus !== "Ошибка ответа") {
    return;
  }

  await persistState(createRuntimeEvent("session", reason), {
    online: latest.online !== false,
    busy: false,
    status: latest.online === false ? "Не на связи" : "На связи",
    message: "",
    source: cleanText(latest.source, 32) || "system",
    emotion: "calm",
    activity: "idle",
    cue: "idle",
    intensity: 0.12,
    speaking: false,
    motion: "idle_soft",
  });
}

function scheduleSpeechSettle(message: string) {
  clearSpeechSettleTimer();
  const delayMs = speechSettleDelayMs(message);
  speechSettleTimer = setTimeout(() => {
    speechSettleTimer = null;
    void settleSpeechState("settled");
  }, delayMs);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return sanitizeAvatarText(content, 220);
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (isObjectRecord(entry)) {
          const entryType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
          if (entryType && entryType !== "text") {
            return "";
          }
          const textValue = typeof entry.text === "string" ? entry.text : "";
          if (textValue) {
            return textValue;
          }
          if (typeof entry.content === "string") {
            return entry.content;
          }
        }
        return "";
      })
      .filter(Boolean);
    return sanitizeAvatarText(parts.join(" "), 220);
  }

  if (isObjectRecord(content)) {
    if (typeof content.text === "string") {
      return sanitizeAvatarText(content.text, 220);
    }
    if (typeof content.content === "string") {
      return sanitizeAvatarText(content.content, 220);
    }
    if (Array.isArray(content.parts)) {
      return extractTextFromContent(content.parts);
    }
  }

  return "";
}

function parseAvatarDirectives(value: unknown) {
  const baseText = typeof value === "string" ? sanitizeAvatarText(value, 240) : extractTextFromContent(value);
  const result = {
    text: sanitizeAvatarText(baseText, 220),
    emotion: "",
    activity: "",
    cue: "",
    motion: "",
    page: "",
    viewPreset: "",
  };
  if (!result.text) {
    return result;
  }
  const found = { emotion: "", activity: "", cue: "", motion: "", page: "", viewPreset: "" };
  const cleaned = result.text.replace(/\[(emotion|activity|cue|motion|page|preset|view|size)\s*:\s*([a-z0-9_-]+)\]/gi, (_, kind, cue) => {
    const key = cleanText(kind, 16).toLowerCase();
    const normalizedCue = cleanText(cue, 32).toLowerCase();
    if ((key === "emotion" || key === "activity" || key === "cue" || key === "motion") && normalizedCue) {
      found[key as "emotion" | "activity" | "cue" | "motion"] = normalizedCue;
    } else if (key === "page" && normalizedCue) {
      found.page = normalizedCue;
    } else if ((key === "preset" || key === "view" || key === "size") && normalizedCue) {
      found.viewPreset = normalizedCue;
    }
    return " ";
  });
  return {
    text: sanitizeAvatarText(cleaned, 220),
    emotion: found.emotion,
    activity: found.activity,
    cue: found.cue,
    motion: found.motion,
    page: found.page,
    viewPreset: found.viewPreset,
  };
}

function resolveControlPatchFromDirectives(parsed: ReturnType<typeof parseAvatarDirectives>) {
  const patch: {
    viewPreset?: PersistedControlState["viewPreset"];
    page?: Partial<PersistedControlState["page"]>;
  } = {};

  const viewPreset = normalizeViewPreset(parsed.viewPreset);
  if (viewPreset) {
    patch.viewPreset = viewPreset;
  }

  const pageDirective = cleanText(parsed.page, 32).toLowerCase();
  if (pageDirective) {
    if (["auto", "none", "reset", "default", "rotation"].includes(pageDirective)) {
      patch.page = {
        mode: "auto",
        target: null,
        until: null,
      };
    } else {
      patch.page = {
        mode: "pinned",
        target: pageDirective,
        until: null,
      };
    }
  }

  return patch;
}

async function resolveMainSessionFile() {
  for (const storePath of uniqueSessionStoreFiles()) {
    const store = await readJson(storePath);
    const entry = isObjectRecord(store) ? store[MAIN_SESSION_KEY] : null;
    if (!isObjectRecord(entry)) {
      continue;
    }

    const directFile = cleanText(entry.sessionFile, 1024);
    if (directFile) {
      return path.normalize(directFile);
    }

    const sessionId = cleanText(entry.sessionId, 128);
    if (sessionId) {
      return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
    }
  }

  return "";
}

async function readTranscriptTail(filePath: string) {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const stats = await handle.stat();
    if (!Number.isFinite(stats.size) || stats.size <= 0) {
      return "";
    }
    const bytesToRead = Math.min(stats.size, TRANSCRIPT_TAIL_BYTES);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, start);
    return buffer.subarray(0, result.bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readLatestAssistantSignal(sessionFile: string) {
  const tail = await readTranscriptTail(sessionFile);
  if (!tail) {
    return null;
  }

  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      const message = isObjectRecord(parsed) && isObjectRecord(parsed.message) ? parsed.message : null;
      if (!message || message.role !== "assistant") {
        continue;
      }

      const text = extractTextFromContent(message.content);
      const error = normalizeErrorText(message.errorMessage ?? message.error);
      if (!text && !error) {
        continue;
      }

      const stopReason = cleanText(message.stopReason, 64).toLowerCase();
      if (stopReason === "tooluse" || stopReason === "tool_use") {
        continue;
      }

      const signature = [
        cleanText(parsed.id, 128),
        cleanText(parsed.timestamp, 64),
        stopReason,
        text,
        error,
      ].join("|");

      return {
        signature,
        text: sanitizeAvatarText(text || error, 220),
        isError: !text && Boolean(error || stopReason === "error"),
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function primeTranscriptWatcher() {
  const sessionFile = await resolveMainSessionFile();
  lastTranscriptSessionFile = sessionFile;
  if (!sessionFile) {
    lastTranscriptSignature = "";
    transcriptPrimed = true;
    return;
  }

  const latest = await readLatestAssistantSignal(sessionFile);
  lastTranscriptSignature = latest?.signature ?? "";
  transcriptPrimed = true;
}

async function pollTranscriptUpdates() {
  if (transcriptPollInFlight) {
    return;
  }
  transcriptPollInFlight = true;
  try {
    if (!transcriptPrimed) {
      await primeTranscriptWatcher();
      return;
    }

    const sessionFile = await resolveMainSessionFile();
    if (!sessionFile) {
      return;
    }

    if (sessionFile !== lastTranscriptSessionFile) {
      lastTranscriptSessionFile = sessionFile;
      const latest = await readLatestAssistantSignal(sessionFile);
      lastTranscriptSignature = latest?.signature ?? "";
      return;
    }

    const latest = await readLatestAssistantSignal(sessionFile);
    if (!latest?.signature || latest.signature === lastTranscriptSignature) {
      return;
    }

    lastTranscriptSignature = latest.signature;
    const previous = await readState();
    const nextStatus = latest.isError ? "Ошибка ответа" : "Говорю";
    const parsed = parseAvatarDirectives(latest.text);
    const nextMessage = latest.isError
      ? normalizeErrorText(parsed.text || latest.text) || "Не удалось получить ответ модели"
      : sanitizeAvatarText(parsed.text, 220);
    const inferred = inferAvatarCue(nextMessage, { isError: latest.isError, status: nextStatus });
    const previousMessage = cleanText(previous.message, 220);
    const previousStatus = cleanText(previous.status, 64);
    if (!previous.busy && previousMessage === nextMessage && previousStatus === nextStatus) {
      return;
    }

    await persistState(createRuntimeEvent("session", "transcript"), {
      online: true,
      busy: false,
      status: nextStatus,
      message: nextMessage,
      source: cleanText(previous.source, 32) || "system",
      emotion: parsed.emotion || inferred.emotion,
      activity: parsed.activity || inferred.activity,
      cue: parsed.cue || inferred.cue || parsed.motion || inferred.motion,
      intensity: inferred.intensity,
      speaking: latest.isError ? false : Boolean(inferred.speaking ?? nextMessage),
      motion: parsed.motion || inferred.motion,
    });
    await persistControl(resolveControlPatchFromDirectives(parsed));
    scheduleSpeechSettle(nextMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[neiri-avatar-state] transcript poll failed: ${message}`);
  } finally {
    transcriptPollInFlight = false;
  }
}

function startTranscriptWatcher() {
  if (transcriptPollTimer) {
    return;
  }

  transcriptPrimed = false;
  void primeTranscriptWatcher();
  transcriptPollTimer = setInterval(() => {
    void pollTranscriptUpdates();
  }, TRANSCRIPT_POLL_MS);
}

const handler = async (event: {
  type: string;
  action: string;
  sessionKey?: string;
  timestamp?: Date;
  context?: Record<string, unknown>;
}) => {
  try {
    const channelId = cleanText(event?.context?.channelId, 32) || "system";
    const commandSource = cleanText(event?.context?.commandSource, 32) || "system";

    if (event.type === "gateway" && event.action === "startup") {
      clearSpeechSettleTimer();
      startTranscriptWatcher();
      await persistState(event, {
        online: true,
        busy: false,
        status: "На связи",
        message: "",
        source: "gateway",
        emotion: "calm",
        activity: "idle",
        cue: "idle",
        intensity: 0.12,
        speaking: false,
        motion: "idle_soft",
      });
      return;
    }

    if (event.type === "message" && event.action === "received") {
      clearSpeechSettleTimer();
      await persistState(event, {
        online: true,
        busy: true,
        status: "Думаю",
        message: "",
        source: channelId,
        emotion: "think",
        activity: "thinking",
        cue: "think",
        intensity: 0.45,
        speaking: false,
        motion: "think",
      });
      return;
    }

    if (event.type === "message" && event.action === "sent") {
      const success = event.context?.success === true;
      const parsed = parseAvatarDirectives(success ? event.context?.content : event.context?.error);
      const nextMessage = success
        ? sanitizeAvatarText(parsed.text, 220)
        : normalizeErrorText(event.context?.error ?? parsed.text) || "Не удалось отправить ответ";
      const nextStatus = success ? "Говорю" : "Ошибка ответа";
      const inferred = inferAvatarCue(nextMessage, { isError: !success, status: nextStatus });
      await persistState(event, {
        online: true,
        busy: false,
        status: nextStatus,
        message: nextMessage,
        source: channelId,
        emotion: parsed.emotion || inferred.emotion,
        activity: parsed.activity || inferred.activity,
        cue: parsed.cue || inferred.cue || parsed.motion || inferred.motion,
        intensity: inferred.intensity,
        speaking: success ? true : false,
        motion: parsed.motion || inferred.motion,
      });
      await persistControl(resolveControlPatchFromDirectives(parsed));
      scheduleSpeechSettle(nextMessage);
      return;
    }

    if (event.type === "command" && event.action === "reset") {
      clearSpeechSettleTimer();
      await persistState(event, {
        online: true,
        busy: false,
        status: "Контекст сброшен",
        message: "",
        source: commandSource,
        emotion: "calm",
        activity: "idle",
        cue: "calm",
        intensity: 0.1,
        speaking: false,
        motion: "calm",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[neiri-avatar-state] ${message}`);
  }
};

export default handler;
