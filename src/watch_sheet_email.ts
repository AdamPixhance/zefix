import { Zefix } from "./index";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import axios from "axios";

type State = Record<
  string,
  { hash: string; updatedAt: string; name?: string; props?: any }
>;

type WatchItem = { uid: string; label?: string; active?: boolean };

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

function sha256(obj: any): string {
  return crypto.createHash("sha256").update(stableStringify(obj)).digest("hex");
}

function loadState(filePath: string): State {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as State;
}
function saveState(filePath: string, state: State) {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

function parseCsv(csvText: string): WatchItem[] {
  // Minimal CSV parser: expects simple CSV (no embedded commas inside quotes).
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const uidIdx = header.indexOf("uid");
  const labelIdx = header.indexOf("label");
  const activeIdx = header.indexOf("active");

  if (uidIdx === -1) throw new Error("CSV must contain a 'uid' column");

  const items: WatchItem[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.trim());
    const uid = cols[uidIdx]?.replace(/^"|"$/g, "");
    if (!uid) continue;

    const label =
      labelIdx !== -1 ? cols[labelIdx]?.replace(/^"|"$/g, "") : undefined;

    let active: boolean | undefined = true;
    if (activeIdx !== -1) {
      const raw = (cols[activeIdx] ?? "")
        .replace(/^"|"$/g, "")
        .toLowerCase();
      active = raw === "" ? true : raw === "true" || raw === "1" || raw === "yes";
    }

    items.push({ uid, label, active });
  }
  return items;
}

function diffObjects(oldObj: any, newObj: any, prefix = ""): string[] {
  // Simple deep diff for objects + primitives (good enough for your normalized props)
  const diffs: string[] = [];
  const allKeys = new Set([
    ...Object.keys(oldObj ?? {}),
    ...Object.keys(newObj ?? {}),
  ]);

  for (const key of Array.from(allKeys).sort()) {
    const o = oldObj?.[key];
    const n = newObj?.[key];
    const pathKey = prefix ? `${prefix}.${key}` : key;

    const oIsObj = o && typeof o === "object" && !Array.isArray(o);
    const nIsObj = n && typeof n === "object" && !Array.isArray(n);

    if (oIsObj || nIsObj) {
      diffs.push(...diffObjects(o ?? {}, n ?? {}, pathKey));
      continue;
    }

    if (Array.isArray(o) || Array.isArray(n)) {
      const oStr = JSON.stringify(o ?? []);
      const nStr = JSON.stringify(n ?? []);
      if (oStr !== nStr) diffs.push(`${pathKey}: ${oStr} → ${nStr}`);
      continue;
    }

    if ((o ?? null) !== (n ?? null)) {
      diffs.push(`${pathKey}: ${String(o ?? "null")} → ${String(n ?? "null")}`);
    }
  }
  return diffs;
}

async function sendEmail(subject: string, text: string) {
  const host = process.env.SMTP_HOST as string;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER as string;
  const pass = process.env.SMTP_PASS as string;
  const to = process.env.ALERT_TO as string;
  const from = process.env.ALERT_FROM as string;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({ from, to, subject, text });
}

async function fetchCsvText(sheetCsvUrl: string): Promise<string> {
  // Google “published CSV” links often download as a file in browsers.
  // In CI, treat the response as bytes and decode.
  const resp = await axios.get(sheetCsvUrl, {
    responseType: "arraybuffer",
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/csv,*/*",
    },
  });

  const csvText = Buffer.from(resp.data).toString("utf8");

  // Basic sanity check: must include the uid header
  if (!csvText.toLowerCase().includes("uid")) {
    throw new Error(
      `Sheet did not return expected CSV. First 200 chars:\n${csvText.slice(0, 200)}`
    );
  }

  return csvText;
}

async function main() {
  const sheetCsvUrl = process.env.SHEET_CSV_URL as string;
  if (!sheetCsvUrl) throw new Error("Missing SHEET_CSV_URL");

  const zefix = new Zefix({
    usr: process.env.USR as string,
    pwd: process.env.PWD as string,
    endpoint: process.env.ENDPOINT as string,
  });

  const statePath = path.resolve(process.cwd(), "watch_state.json");
  const state = loadState(statePath);

  const csvText = await fetchCsvText(sheetCsvUrl);
  const watchItems = parseCsv(csvText).filter((i) => i.active !== false);

  const now = new Date().toISOString();
  const changes: Array<{ uid: string; label?: string; url?: string; diffs: string[] }> = [];
  const baselined: string[] = [];
  const checked: string[] = [];

  for (const item of watchItems) {
    const uid = item.uid;

    if (!zefix.isValidString(uid)) continue;

    const details = await zefix.getCompanyDetails(uid);
    if (!details) continue;

    const address = {
      organisation: details.address.organisation,
      careOf: details.address.careOf,
      street: details.address.street,
      houseNumber: details.address.houseNumber,
      addon: details.address.addon,
      poBox: details.address.poBox,
      city: details.address.city,
      swissZipCode: details.address.swissZipCode,
    };

    const props = {
      uid: details.uid,
      name: details.name,
      legalSeat: details.legalSeat,
      legalForm: `${details.legalForm.name.en} (${details.legalForm.shortName.en})`,
      status: details.status,
      purpose: details.purpose,
      canton: details.canton,
      capitalNominal: details.capitalNominal,
      capitalCurrency: details.capitalCurrency,
      address,
      zefixDetailWeb: details.zefixDetailWeb.en,
    };

    if (props.uid === null) continue;
    const uidKey: string = props.uid;

    checked.push(`${uidKey} ${item.label ?? props.name ?? ""}`.trim());

    const newHash = sha256(props);
    const prev = state[uidKey];

    if (!prev) {
      state[uidKey] = { hash: newHash, updatedAt: now, name: props.name ?? undefined, props };
      baselined.push(`${uidKey} ${item.label ?? props.name ?? ""}`.trim());
      continue;
    }

    if (prev.hash !== newHash) {
      const diffs = diffObjects(prev.props ?? {}, props);
      changes.push({
        uid: uidKey,
        label: item.label ?? props.name ?? undefined,
        url: props.zefixDetailWeb,
        diffs,
      });

      state[uidKey] = { hash: newHash, updatedAt: now, name: props.name ?? undefined, props };
    } else {
      // keep props stored, but update timestamp
      state[uidKey] = { ...prev, updatedAt: now };
    }
  }

  saveState(statePath, state);

  // Email digest ALWAYS (no changes or changes)
  const subject =
    changes.length === 0
      ? `ZEFIX Watch — No changes (${now})`
      : `ZEFIX Watch — ${changes.length} changed (${now})`;

  const lines: string[] = [];
  lines.push(`Run time: ${now}`);
  lines.push(`Checked: ${checked.length}`);
  lines.push("");

  if (baselined.length > 0) {
    lines.push("New baselines created:");
    for (const b of baselined) lines.push(`- ${b}`);
    lines.push("");
  }

  if (changes.length === 0) {
    lines.push("No changes detected.");
  } else {
    lines.push("Changes detected:");
    lines.push("");
    for (const c of changes) {
      lines.push(`UID: ${c.uid}`);
      if (c.label) lines.push(`Label: ${c.label}`);
      if (c.url) lines.push(`ZEFIX: ${c.url}`);
      lines.push("Diff:");
      for (const d of c.diffs) lines.push(`- ${d}`);
      lines.push("");
    }
  }

  await sendEmail(subject, lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
