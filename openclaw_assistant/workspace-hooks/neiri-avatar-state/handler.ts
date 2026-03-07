import fs from "node:fs/promises";
import path from "node:path";

const EXTRA_STATE_FILES = (process.env.NEIRI_STATE_FILES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const STATE_FILES = [
  "/config/www/live2d/neiri-state.json",
  "/homeassistant/www/live2d/neiri-state.json",
  "/data/homeassistant/www/live2d/neiri-state.json",
  "/mnt/data/supervisor/homeassistant/www/live2d/neiri-state.json",
  ...EXTRA_STATE_FILES,
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
const ASSISTANT_NAME = "Нейри";
const HA_BASE_URL_ENV = process.env.NEIRI_HA_URL?.trim() || "";
const HA_BASE_URL_FALLBACKS = [
  "http://homeassistant:8123",
  "http://homeassistant.local:8123",
  "http://localhost:8123",
];
const HA_TOKEN_FILE = "/config/secrets/homeassistant.token";
const HA_TIMEOUT_MS = 5000;
const HA_ENTITIES = {
  online: "input_boolean.neiri_online",
  busy: "input_boolean.neiri_busy",
  status: "input_text.neiri_status",
  message: "input_text.neiri_message",
  source: "input_text.neiri_source",
  updatedAt: "input_text.neiri_updated_at",
  emotion: "input_text.neiri_emotion",
  motion: "input_text.neiri_motion",
  revision: "input_number.neiri_revision",
};

let haTokenPromise: Promise<string> | null = null;
let resolvedHaBaseUrl = "";
let transcriptPollTimer: ReturnType<typeof setInterval> | null = null;
let transcriptPollInFlight = false;
let transcriptPrimed = false;
let lastTranscriptSessionFile = "";
let lastTranscriptSignature = "";
let speechSettleTimer: ReturnType<typeof setTimeout> | null = null;

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

function uniqueSessionStoreFiles() {
  return Array.from(new Set(SESSION_STORE_FILES.map((file) => path.normalize(file))));
}

function uniqueHaBaseUrls() {
  return Array.from(
    new Set([resolvedHaBaseUrl, HA_BASE_URL_ENV, ...HA_BASE_URL_FALLBACKS].filter(Boolean)),
  );
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
    return { motion: "think", emotion: "think" };
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
    return { motion: "error", emotion: "error" };
  }

  if (containsAny(full, ["предупреж", "внимание", "осторож", "ай-яй", "ай ай", "аккуратн"])) {
    return { motion: "warning", emotion: "warning" };
  }

  if (containsAny(full, ["не уверен", "растер", "пута", "непонят", "confused", "unknown", "хм..."])) {
    return { motion: "confused", emotion: "confused" };
  }

  if (containsAny(full, ["не буду", "отказываюсь", "нельзя", "запрещено", "не могу помочь с этим"])) {
    return { motion: "refuse", emotion: "refuse" };
  }

  if (containsAny(full, ["спасибо", "готово", "сделано", "получилось", "умнич", "подтверждаю", "успех"])) {
    return { motion: "approve", emotion: "approve" };
  }

  if (containsAny(full, ["как и ожидал", "я же говорила", "предсказуемо", "понятно же"])) {
    return { motion: "reply_dry", emotion: "reply_dry" };
  }

  if (containsAny(full, ["думаю", "анализир", "считаю", "проверяю", "ищу", "подожди"])) {
    return { motion: "think", emotion: "think" };
  }

  if (containsAny(full, ["ой", "ого", "вау", "неожиданно", "удивительно"])) {
    return { motion: "surprise", emotion: "surprise" };
  }

  if (containsAny(full, ["мяу", "ня", "милаш", "милота", "няш", "обнял", "обним", "лапушка", "котик"])) {
    return { motion: "cute", emotion: "cute" };
  }

  if (containsAny(full, ["извини", "прости", "смущ", "стесня", "неудобно"])) {
    return { motion: "shy", emotion: "shy" };
  }

  if (containsAny(full, ["ура", "класс", "супер", "отлично", "замечательно", "круто"]) || emphatic) {
    return { motion: "reply_excited", emotion: "reply_excited" };
  }

  if (text.includes("?")) {
    return { motion: "reply_soft", emotion: "reply_soft" };
  }

  if (text.length > 0 && text.length <= 60) {
    return { motion: "reply_soft", emotion: "reply_soft" };
  }

  if (text.length > 0) {
    return { motion: "reply", emotion: "reply" };
  }

  return { motion: "calm", emotion: "calm" };
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
    throw new Error(failures || "Failed to write neiri state to all targets");
  }
  if (failures) {
    console.warn(`[neiri-avatar-state] state write partial failure: ${failures}`);
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
      entity_id: HA_ENTITIES.motion,
      value: cleanText(state.motion, 64),
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

async function persistState(
  event: { type: string; action: string; timestamp?: Date } | null,
  patch: Record<string, unknown>,
) {
  const previous = await readState();
  const eventKey = event ? `${event.type}:${event.action}` : "runtime:update";
  const nextState = {
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
  const result = { text: sanitizeAvatarText(baseText, 220), emotion: "", motion: "" };
  if (!result.text) {
    return result;
  }
  const found = { emotion: "", motion: "" };
  const cleaned = result.text.replace(/\[(emotion|motion)\s*:\s*([a-z0-9_-]+)\]/gi, (_, kind, cue) => {
    const key = cleanText(kind, 16).toLowerCase();
    const normalizedCue = cleanText(cue, 32).toLowerCase();
    if ((key === "emotion" || key === "motion") && normalizedCue) {
      found[key] = normalizedCue;
    }
    return " ";
  });
  return { text: sanitizeAvatarText(cleaned, 220), emotion: found.emotion, motion: found.motion };
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
      motion: parsed.motion || inferred.motion,
    });
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
        motion: parsed.motion || inferred.motion,
      });
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
        motion: "calm",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[neiri-avatar-state] ${message}`);
  }
};

export default handler;

