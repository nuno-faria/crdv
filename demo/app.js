// @ts-nocheck

import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.4/dist/index.js";
import { select as d3Select } from "https://cdn.jsdelivr.net/npm/d3-selection@3.0.0/+esm";
import "https://cdn.jsdelivr.net/npm/d3-transition@3.0.1/+esm";
import hljs from "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/es/core.min.js";
import sqlLanguage from "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/es/languages/sql.min.js";
import { schema } from "./schema.js";

hljs.registerLanguage("sql", sqlLanguage);

// timeline event
class TimelineEvent {
  constructor(id, col, lane, kind) {
    this.id = id;
    this.col = col;
    this.lane = lane;
    this.kind = kind;
    this.time = new Date().toLocaleTimeString([], { hour12: false });
  }
}

// timeline link
class Link {
  constructor(id, fromCol, fromLane, toCol, toLane) {
    this.id = id;
    this.fromCol = fromCol;
    this.fromLane = fromLane;
    this.toCol = toCol;
    this.toLane = toLane;
  }
}

class Timeline {
  LANES = [32, 88]
  LEFT = -80;
  SPACING_BETWEEN_EVENTS = 60;
  MAX_EVENTS = 20;
  TRANSITION_DURATION = 300;

  constructor(selector) {
    this.svg = d3Select(selector);
    this.gEvents = this.svg.select("#events");
    this.gLinks = this.svg.select("#links");

    const saved = this.load();
    this.seq = saved.seq ?? 0;
    this.nextId = saved.nextId ?? 1;
    this.events = saved.events ?? []; // TimelineEvent[]
    this.links = saved.links ?? []; // Link[]

    this.render();
  }

  load() {
    try {
      return JSON.parse(localStorage.getItem("timeline")) ?? {};
    } catch {
      return {};
    }
  }

  save() {
    localStorage.setItem(
      "timeline",
      JSON.stringify({
        seq: this.seq,
        nextId: this.nextId,
        events: this.events,
        links: this.links,
      }),
    );
  }

  render() {
    const minCol = this.seq - this.MAX_EVENTS;

    // remove elements that go out of the window
    this.events = this.events.filter((e) => e.col >= minCol);
    this.links = this.links.filter((l) => l.fromCol >= minCol);

    // compute the new x positions for each column id
    const colXPos = (c) =>
      this.LEFT + (c - minCol) * this.SPACING_BETWEEN_EVENTS;

    // events
    const eventPos = (d) =>
      `translate(${colXPos(d.col)}, ${this.LANES[d.lane]})`;
    const events = this.gEvents.selectAll("g").data(this.events, (d) => d.id);

    events
      .exit()
      .transition()
      .duration(this.TRANSITION_DURATION)
      .style("opacity", 0)
      .remove();

    const newEvents = events
      .enter()
      .append("g")
      .attr("class", (d) => d.kind)
      .attr("transform", eventPos)
      .style("opacity", 0);

    newEvents.append("circle");
    newEvents
      .append("text")
      .attr("y", (d) => (d.lane === 1 ? 18 : -10))
      .text((d) => d.time);

    events
      .merge(newEvents)
      .transition()
      .duration(this.TRANSITION_DURATION)
      .style("opacity", 1)
      .attr("transform", eventPos);

    // links
    const links = this.gLinks.selectAll("line").data(this.links, (d) => d.id);

    links
      .exit()
      .transition()
      .duration(this.TRANSITION_DURATION)
      .style("opacity", 0)
      .remove();

    const newLinks = links
      .enter()
      .append("line")
      .attr("x1", (d) => colXPos(d.fromCol))
      .attr("y1", (d) => this.LANES[d.fromLane])
      .attr("x2", (d) => colXPos(d.toCol))
      .attr("y2", (d) => this.LANES[d.toLane])
      .style("opacity", 0);

    links
      .merge(newLinks)
      .transition()
      .duration(this.TRANSITION_DURATION)
      .style("opacity", 1)
      .attr("x1", (d) => colXPos(d.fromCol))
      .attr("x2", (d) => colXPos(d.toCol));

    this.save();
  }

  addWrite(lane) {
    this.events.push(
      new TimelineEvent(this.nextId++, this.seq++, lane, "write"),
    );
    this.render();
  }

  addReplication() {
    const c0 = this.seq++;
    const c1 = this.seq++;
    this.events.push(new TimelineEvent(this.nextId++, c0, 0, "replicate"));
    this.events.push(new TimelineEvent(this.nextId++, c0, 1, "replicate"));
    this.events.push(new TimelineEvent(this.nextId++, c1, 0, "replicate"));
    this.events.push(new TimelineEvent(this.nextId++, c1, 1, "replicate"));
    this.links.push(new Link(this.nextId++, c0, 0, c1, 1));
    this.links.push(new Link(this.nextId++, c0, 1, c1, 0));
    this.render();
  }

  // Clear the events and links
  clear() {
    this.seq = 0;
    this.nextId = 1;
    this.events = [];
    this.links = [];
    this.render();
  }
}

// Creates a new element with the given tag; optionally receives a className and text
function createElem(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

// Formats a cell from pglite
function pgliteValueToString(value) {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return `{${String(value)}}`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

// Shows the latest entries received in a modal
class HistoryModal {
  constructor() {
    this.modal = document.getElementById("history-modal");
    this.list = document.getElementById("history-list");
    this.closeButton = document.getElementById("history-close");

    this.closeButton.addEventListener("click", () => this.close());
    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });
  }

  open({ entries, onSelect }) {
    this.renderEntries(entries, onSelect);
    this.modal.style.display = "flex";
  }

  close() {
    this.list.textContent = "";
    this.list.scrollTop = 0;
    this.modal.style.display = "none";
  }

  renderEntries(entries, onSelect) {
    if (entries.length === 0) {
      this.list.appendChild(
        createElem("div", "text-sm", "No history yet"),
      );
      return;
    }

    [...entries].reverse().forEach((entry) => {
      const row = createElem("div", "history-row");
      const top = createElem("div", "flex items-center justify-between gap-2");
      const meta = createElem("div", "flex gap-3 items-baseline");

      meta.appendChild(
        createElem("span", "text-xs code text-gray-500", entry.time),
      );
      meta.appendChild(
        createElem("span", "text-xs code text-gray-500", entry.summary),
      );

      const useButton = createElem("button", "btn btn-primary", "▶︎ Run");
      useButton.addEventListener("click", () => {
        onSelect(entry.sql);
        this.close();
      });

      top.appendChild(meta);
      top.appendChild(useButton);

      row.appendChild(top);
      const sqlElem = createElem("div", "code text-xs");
      sqlElem.innerHTML = hljs.highlight(entry.sql, { language: "sql" }).value;
      row.appendChild(sqlElem);
      this.list.appendChild(row);
    });
  }
}

class Terminal {
  HISTORY_LIMIT = 20;

  constructor(id, rootId, dbPath, timeline) {
    this.id = id;
    this.lane = id - 1;
    this.timeline = timeline;
    this.historyModal = new HistoryModal();
    this.storageKey = "history:" + rootId;
    this.history = this.loadHistory();
    this.db = new PGlite(dbPath);

    const root = document.getElementById(rootId);
    this.sqlElem = root.querySelector("[data-sql]");
    this.outputElem = root.querySelector("[data-output]");
    this.badge = root.querySelector("[data-badge]");
    this.runButton = root.querySelector("[data-run]");
    this.queryPresentButton = root.querySelector("[data-query-present]");
    this.queryHistoryButton = root.querySelector("[data-query-history]");
    this.historyButton = root.querySelector("[data-history]");

    this.runButton.addEventListener("click", () =>
      this.run(this.sqlElem.value),
    );
    this.queryPresentButton.addEventListener("click", () =>
      this.run("SELECT id, key, type, data, site, lts, op FROM Data"),
    );
    this.queryHistoryButton.addEventListener("click", () =>
      this.run("SELECT id, key, type, data, site, lts, op FROM Shared"),
    );
    this.historyButton.addEventListener("click", () => {
      this.historyModal.open({
        entries: this.history,
        onSelect: (sql) => {
          this.sqlElem.value = sql;
          this.sqlElem.dispatchEvent(new Event("input"));
          this.run(sql);
        },
      });
    });
    this.sqlElem.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.run(this.sqlElem.value);
      }
    });

    // disable the run button when there is no code to execute
    const checkRunButton = () => {
      this.runButton.disabled = this.sqlElem.value.trim() === "";
    };
    this.sqlElem.addEventListener("input", checkRunButton);
    checkRunButton();

    this.ready = (async () => {
      await this.db.waitReady;
      await this.createDatabase(false);
    })();
  }

  // If `recreate` is true, drops the database first, otherwise skips creation if it is already
  // fully created.
  async createDatabase(recreate) {
    if (!recreate) {
      try {
        await this.db.exec("select from __schema_created");
        this.badge.classList.remove("loading");
        this.badge.classList.add("ready");
        return;
      } catch {}
    }

    this.badge.classList.remove("ready");
    this.badge.classList.add("loading");

    await this.db.exec(schema.drop);
    await this.db.exec(schema.create);
    await this.db.query("select initSite($1)", [this.id]);
    await this.db.query("select addRemoteSite($1)", [(this.id % 2) + 1]);
    await this.db.query("create table __schema_created ()");

    this.badge.classList.remove("loading");
    this.badge.classList.add("ready");
  }

  // Run a SQL query
  async run(sql) {
    if (!sql) {
      return;
    }
    try {
      const historyCountBefore = await this.getSharedCount();
      const result = (await this.db.exec(sql)).at(-1);
      const historyCountAfter = await this.getSharedCount();

      this.renderResult(sql, result);
      if (historyCountAfter > historyCountBefore) {
        this.timeline.addWrite(this.lane);
      }
      this.recordHistory(sql, result);
    } catch (err) {
      this.renderError(sql, err);
    }
  }

  // Count History rows.
  // Returns 0 if it fails, which can happen if the current transaction is aborted.
  async getSharedCount() {
    try {
      const result = await this.db.query("select count(*) c from shared");
      return result.rows[0]["c"];
    } catch {
      return 0;
    }
  }

  recordHistory(sql, result) {
    const isWrite = !(result.fields && result.fields.length > 0);
    const n = isWrite ? result.affectedRows : result.rows.length;
    const summary = `${n} row${n === 1 ? "" : "s"} ${isWrite ? "affected" : "returned"}`;

    this.history.push({ time: new Date().toLocaleTimeString(), sql, summary });
    if (this.history.length > this.HISTORY_LIMIT) {
      this.history.shift();
    }
    this.saveHistory();
  }

  loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey)) ?? [];
    } catch {
      return [];
    }
  }

  saveHistory() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.history));
  }

  // Re-create the database
  async clear() {
    await this.createDatabase(true);
    this.outputElem.textContent = "";
    this.history = [];
    this.saveHistory();
  }

  // Renders the result of a query
  renderResult(sql, result) {
    this.outputElem.textContent = "";
    this.outputElem.appendChild(
      createElem(
        "div",
        "msg hdr",
        "> " + (sql.length > 295 ? sql.slice(0, 295) + "..." : sql),
      ),
    );

    const isWrite = !(result.fields && result.fields.length > 0);
    if (isWrite) {
      const n = result.affectedRows;
      const label = `${n} row${n === 1 ? "" : "s"} affected`;
      this.outputElem.appendChild(createElem("div", "msg ok", label));
    } else {
      const table = createElem("table", "result");
      const thead = createElem("thead");
      const htr = createElem("tr");
      const tbody = createElem("tbody");
      const cols = result.fields.map((f) => f.name);

      cols.forEach((c) => htr.appendChild(createElem("th", null, c)));
      thead.appendChild(htr);
      table.appendChild(thead);

      result.rows.forEach((r) => {
        const tr = createElem("tr");
        cols.forEach((c) =>
          tr.appendChild(
            createElem(
              "td",
              null,
              r[c] === null ? "NULL" : pgliteValueToString(r[c]),
            ),
          ),
        );
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      // left-align explain output
      const alignment = cols.includes("QUERY PLAN") ? "left" : null;
      if (alignment) {
        table.querySelectorAll("th, td").forEach((cell) => {
          cell.style.textAlign = alignment;
        });
      }

      this.outputElem.appendChild(table);

      // num rows text
      const n = result.rows ? result.rows.length : 0;
      this.outputElem.appendChild(
        createElem("div", "msg", `(${n} row${n === 1 ? "" : "s"})`),
      );
    }
  }

  // Renders an error message (e.g., invalid syntax)
  renderError(sql, err) {
    this.outputElem.textContent = "";
    this.outputElem.appendChild(createElem("div", "msg hdr", "> " + sql));
    this.outputElem.appendChild(
      createElem(
        "div",
        "msg err",
        "ERROR: " + (err && err.message ? err.message : String(err)),
      ),
    );
  }
}

class Replicator {
  constructor(db1, db2, timeline) {
    this.buttons = document.querySelectorAll("[data-replicate]");
    this.db1 = db1;
    this.db2 = db2;
    this.timeline = timeline;

    this.buttons.forEach((button) =>
      button.addEventListener("click", () => this.replicate()),
    );

    Promise.all([this.db1.ready, this.db2.ready]).then(() => {
      this.buttons.forEach((button) => (button.disabled = false));
    });
  }

  async replicate() {
    this.buttons.forEach((button) => (button.disabled = true));
    try {
      const [history1, history2] = await Promise.all([
        this.db1.query("SELECT * FROM Shared"),
        this.db2.query("SELECT * FROM Shared"),
      ]);

      const upsert = `
        INSERT INTO Shared (id, key, type, data, site, lts, pts, op, seq) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `;
      await this.db1.transaction(async (tx) => {
        for (const row of history2.rows) {
          await tx.query(upsert, Object.values(row).map(pgliteValueToString));
        }
      });
      await this.db2.transaction(async (tx) => {
        for (const row of history1.rows) {
          await tx.query(upsert, Object.values(row).map(pgliteValueToString));
        }
      });

      await Promise.all([
        this.db1.query("SELECT merge()"),
        this.db2.query("SELECT merge()"),
      ]);

      this.timeline.addReplication();
    } catch (err) {
      console.error("Replication failed:", err);
    } finally {
      this.buttons.forEach((button) => (button.disabled = false));
    }
  }
}

class ClearData {
  constructor(clearId, confirmId, cancelId, terminals, timeline) {
    this.clearButton = document.getElementById(clearId);
    this.confirmButton = document.getElementById(confirmId);
    this.cancelButton = document.getElementById(cancelId);
    this.terminals = terminals;
    this.timeline = timeline;

    this.clearButton.addEventListener("click", () => this.showConfirm());
    this.cancelButton.addEventListener("click", () => this.showClear());
    this.confirmButton.addEventListener("click", () => this.clear());
  }

  showClear() {
    this.clearButton.classList.remove("hidden");
    this.confirmButton.classList.add("hidden");
    this.cancelButton.classList.add("hidden");
  }

  showConfirm() {
    this.clearButton.classList.add("hidden");
    this.confirmButton.classList.remove("hidden");
    this.cancelButton.classList.remove("hidden");
  }

  async clear() {
    this.showClear();
    this.timeline.clear();
    await Promise.all(this.terminals.map((t) => t.clear()));
  }
}

// light/dark theme toggle
document.getElementById("theme-toggle").addEventListener("click", () => {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
});

// highlight the code examples
document.querySelectorAll(".code-area .sql").forEach((span) => {
  span.innerHTML = hljs.highlight(span.textContent.trim(), {
    language: "sql",
  }).value;
});

const timeline = new Timeline("#timeline");
const t1 = new Terminal(1, "term1", "idb://pg-site-1", timeline);
const t2 = new Terminal(2, "term2", "idb://pg-site-2", timeline);
new Replicator(t1.db, t2.db, timeline);
new ClearData("clear", "clear-confirm", "clear-cancel", [t1, t2], timeline);

// run buttons on the code snippets
const terminalsBySite = { 1: t1, 2: t2 };
document.querySelectorAll("[data-run-example]").forEach((button) => {
  const terminal = terminalsBySite[button.closest("[data-site]").dataset.site];
  const sql = button.nextElementSibling.textContent.trim();

  button.addEventListener("click", () => {
    terminal.sqlElem.value = sql;
    terminal.sqlElem.dispatchEvent(new Event("input"));
    terminal.run(sql);
  });
});
