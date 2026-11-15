import fs from "node:fs";
import path from "node:path";

/**
 * Persistent set of APPROVED proof references, for PROOF_REUSED detection.
 *
 * Only proofs this agent APPROVED are recorded. A rejected proof that is
 * re-sent must be judged again on its own fields (it may be a different
 * trap), not auto-flagged as reused.
 *
 * Storage is a JSON file (default ./data/seen.json). Writes are best-effort
 * and synchronous so a restart immediately after an APPROVE does not lose
 * the record. For production, point SEEN_FILE at persistent disk.
 */
export class SeenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.set = new Set();
    this.load();
  }

  static normalize(proofTx) {
    return String(proofTx || "").trim().toLowerCase();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.seen)
          ? parsed.seen
          : [];
      for (const item of list) {
        const n = SeenStore.normalize(item);
        if (n) this.set.add(n);
      }
    } catch (err) {
      console.error(`[seen] failed to load ${this.filePath}: ${err.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify([...this.set].sort(), null, 2),
        "utf8",
      );
    } catch (err) {
      console.error(`[seen] failed to save ${this.filePath}: ${err.message}`);
    }
  }

  has(proofTx) {
    const n = SeenStore.normalize(proofTx);
    return n ? this.set.has(n) : false;
  }

  add(proofTx) {
    const n = SeenStore.normalize(proofTx);
    if (!n) return false;
    if (this.set.has(n)) return false;
    this.set.add(n);
    this.save();
    return true;
  }

  get size() {
    return this.set.size;
  }
}

/**
 * Persistent idempotency cache: task_id -> response object.
 * The platform may retry after a network failure; retries must return the
 * exact same response. Stored as JSON (default ./data/responses.json).
 */
export class ResponseCache {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const obj = parsed && typeof parsed === "object" ? parsed : {};
      for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
    } catch (err) {
      console.error(`[cache] failed to load ${this.filePath}: ${err.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(Object.fromEntries(this.map), null, 2),
        "utf8",
      );
    } catch (err) {
      console.error(`[cache] failed to save ${this.filePath}: ${err.message}`);
    }
  }

  get(taskId) {
    return taskId ? this.map.get(taskId) : undefined;
  }

  set(taskId, response) {
    if (!taskId) return;
    this.map.set(taskId, response);
    this.save();
  }
}
