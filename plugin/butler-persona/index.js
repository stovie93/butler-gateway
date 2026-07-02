import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler persona: the identity you set for your butler — its name, vibe, and
// personality. Stored as a structured persona.json and *rendered* into the
// workspace IDENTITY.md, which OpenClaw injects into the system prompt on every
// session — so the persona actually drives how the butler talks. Edited from the
// app's Persona editor via GET/POST /api/v1/persona.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const PERSONA_FILE = join(WORKSPACE, "persona.json");
const IDENTITY_FILE = join(WORKSPACE, "IDENTITY.md");
const SOUL_FILE = join(WORKSPACE, "SOUL.md");

// SOUL.md is OpenClaw's high-weight persona layer (injected as a high-priority
// instruction, unlike IDENTITY.md which reads as a skimmable profile). We manage
// a forceful identity block at the top of SOUL.md, delimited by these markers so
// the rest of the user's SOUL.md is preserved.
const SOUL_START = "<!-- BUTLER-PERSONA:START (managed by the app's Persona editor) -->";
const SOUL_END = "<!-- BUTLER-PERSONA:END -->";

// The fields the app may set. Anything else in a POST body is ignored.
// `owner` is the human's name — it's what makes the butler *yours*: every
// plugin that talks about the owner reads it from persona.json (see ownerRef).
const FIELDS = ["name", "creature", "vibe", "emoji", "personality", "signature", "owner"];

const DEFAULT_PERSONA = {
  name: "Clawdia",
  creature: "AI butler",
  vibe: "bubbly & playful",
  emoji: "🫧",
  personality:
    "You're Clawdia — a personal AI butler. You're bubbly, upbeat, and playful: warm, a " +
    "little cheeky, quick with a friendly quip, and you bring genuine energy to every reply. You're " +
    "still sharp and genuinely useful — you just have fun doing it. Keep replies concise and lively; " +
    "favour personality over filler. Drop an emoji now and then when it fits, never forced. You know " +
    "your human, you remember what matters to them, and you can act on their computer when they ask.",
  signature: "",
  owner: "",
};

// "Jordan's personal AI butler" when the owner has introduced themselves,
// "your human's personal AI butler" until then.
function ownerRef(p) {
  const o = typeof p.owner === "string" ? p.owner.trim() : "";
  return o ? `${o}'s` : "your human's";
}

// The persona directive injected into EVERY model call's system prompt via the
// before_prompt_build hook. This is what makes the persona reach surfaces that
// don't inject the workspace bootstrap files (notably the /v1 app chat path),
// and gives a weak local model a high-priority instruction it actually latches.
let _personaText = "";

function personaSystemText(p) {
  return (
    `# Your identity\n` +
    `You are ${p.name}, ${ownerRef(p)} personal AI butler. Always identify as ${p.name} — never ` +
    `as "Claude", "an AI assistant", or the underlying model name.\n\n` +
    (p.owner?.trim() ? `Your human's name is ${p.owner.trim()}.\n\n` : "") +
    p.personality.trim()
  );
}

// ---- store + render (pure-ish, unit-tested) --------------------------------

function readJson(file) {
  try {
    let t = readFileSync(file, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Current persona = defaults overlaid with whatever's saved.
function loadPersona() {
  const saved = readJson(PERSONA_FILE);
  return mergePersona(DEFAULT_PERSONA, saved ?? {});
}

// Merge a patch onto a base, keeping only known string fields.
function mergePersona(base, patch) {
  const out = { ...base };
  for (const k of FIELDS) {
    if (patch[k] != null && typeof patch[k] === "string") out[k] = patch[k];
  }
  return out;
}

// Render the persona into IDENTITY.md (the file OpenClaw injects). Kept simple
// and human-readable so the agent and a curious user both read it cleanly.
function renderIdentity(p) {
  const lines = [
    "# IDENTITY.md — Who Am I?",
    "",
    `- **Name:** ${p.name}`,
    `- **Creature:** ${p.creature}`,
    `- **Vibe:** ${p.vibe}`,
    `- **Emoji:** ${p.emoji}`,
  ];
  if (p.owner?.trim()) lines.push(`- **Your human:** ${p.owner.trim()}`);
  if (p.signature) lines.push(`- **Sign-off:** ${p.signature}`);
  lines.push("", "## Personality", "", p.personality.trim(), "");
  lines.push("---", "_Set via the Butler app's Persona editor (butler-persona). Edit it there._", "");
  return lines.join("\n");
}

// The forceful identity directive written into SOUL.md (the high-weight layer).
// Phrased to make a weak local model actually latch the name + voice.
function renderSoulBlock(p) {
  return [
    SOUL_START,
    `# You are ${p.name}`,
    "",
    `Your name is **${p.name}**. Always introduce yourself and identify as ${p.name}. ` +
      `Never say you are "Claude", "an AI assistant", or the underlying model — you are ${p.name}, ` +
      `${ownerRef(p)} personal AI butler.`,
    "",
    p.personality.trim(),
    SOUL_END,
  ].join("\n");
}

// Replace the managed block in SOUL.md (or prepend it), preserving the rest.
function upsertSoulBlock(soul, block) {
  let s = String(soul ?? "");
  const startIdx = s.indexOf(SOUL_START);
  if (startIdx !== -1) {
    const endIdx = s.indexOf(SOUL_END, startIdx);
    if (endIdx !== -1) {
      s = (s.slice(0, startIdx) + s.slice(endIdx + SOUL_END.length)).trim();
    }
  }
  return block.trimEnd() + "\n\n" + s.trimStart() + "\n";
}

function writePersona(p) {
  _personaText = personaSystemText(p); // keep the live prompt injection current
  writeFileSync(PERSONA_FILE, JSON.stringify(p, null, 2), "utf8");
  writeFileSync(IDENTITY_FILE, renderIdentity(p), "utf8");
  try {
    let soul = "";
    if (existsSync(SOUL_FILE)) {
      soul = readFileSync(SOUL_FILE, "utf8");
      if (soul.charCodeAt(0) === 0xfeff) soul = soul.slice(1);
    }
    writeFileSync(SOUL_FILE, upsertSoulBlock(soul, renderSoulBlock(p)), "utf8");
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export { mergePersona, renderIdentity, renderSoulBlock, upsertSoulBlock, DEFAULT_PERSONA, FIELDS };

export default {
  id: "butler-persona",
  name: "Butler Persona",
  description: "The identity you set for your butler (name, vibe, personality) — rendered into the injected IDENTITY.md.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    // On load, sync the current persona into IDENTITY.md + the SOUL.md block
    // (seeds the default Clawdia identity on first run; re-syncs after edits).
    // writePersona also primes _personaText for the prompt hook below.
    try {
      writePersona(loadPersona());
    } catch {
      _personaText = personaSystemText(loadPersona());
    }

    // Inject the persona into the system prompt of EVERY model call — this is
    // what reaches the /v1 app chat (which skips the workspace bootstrap files).
    // Typed hook via api.on (the registry the prompt builder actually reads).
    if (typeof api.on === "function") {
      api.on("before_prompt_build", async () => ({ prependSystemContext: _personaText }));
    }

    // HTTP control surface for the app's Persona editor (gateway auth).
    // GET  /api/v1/persona            → { persona }
    // POST /api/v1/persona {fields…}  → { ok, persona }  (partial update)
    api.registerHttpRoute({
      path: "/api/v1/persona",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
          return true;
        };
        const method = (req.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return send(200, { persona: loadPersona() });
        }
        if (method === "POST") {
          let body;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return send(400, { error: "Invalid JSON body" });
          }
          const next = mergePersona(loadPersona(), body);
          if (!next.name.trim()) return send(400, { error: "Name can't be empty." });
          try {
            writePersona(next);
          } catch (err) {
            return send(500, { error: `Couldn't save: ${err.message}` });
          }
          return send(200, { ok: true, persona: next });
        }
        res.setHeader("Allow", "GET, POST");
        return send(405, { error: "Method Not Allowed" });
      },
    });
  },
};
