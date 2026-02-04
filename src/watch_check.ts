import { Zefix } from "./index";
import crypto from "crypto";
import fs from "fs";
import path from "path";

type State = Record<string, { hash: string; updatedAt: string; name?: string }>;

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
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

async function main() {
  const zefix = new Zefix({
    usr: process.env.USR as string,
    pwd: process.env.PWD as string,
    endpoint: process.env.ENDPOINT as string,
  });

  const query = process.env.COMPANY as string;

  const result = await zefix.searchCompany(query);
  if (!result || result.length === 0) {
    console.log("No company found");
    return;
  }

  const first = result.find((c) => c.uid && zefix.isValidString(c.uid));
  if (!first?.uid) {
    console.log("No valid UID found in results");
    return;
  }

  const details = await zefix.getCompanyDetails(first.uid);
  if (!details) {
    console.log("No details returned for UID:", first.uid);
    return;
  }

  // Normalize exactly like demo.ts
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

  // IMPORTANT: force a non-null string key for indexing state
  if (props.uid === null) {
    console.log("Details returned UID=null; cannot track changes.");
    return;
  }
  const uidKey: string = props.uid;

  const newHash = sha256(props);

  const statePath = path.resolve(process.cwd(), "watch_state.json");
  const state = loadState(statePath);

  const prev = state[uidKey]?.hash;

  if (!prev) {
    state[uidKey] = {
      hash: newHash,
      updatedAt: new Date().toISOString(),
      name: props.name ?? undefined,
    };
    saveState(statePath, state);
    console.log("BASELINE STORED");
    console.log("UID:", uidKey);
    console.log("HASH:", newHash);
    return;
  }

  if (prev === newHash) {
    console.log("NO CHANGE");
    console.log("UID:", uidKey);
    return;
  }

  state[uidKey] = {
    hash: newHash,
    updatedAt: new Date().toISOString(),
    name: props.name ?? undefined,
  };
  saveState(statePath, state);

  console.log("CHANGED!");
  console.log("UID:", uidKey);
  console.log("OLD HASH:", prev);
  console.log("NEW HASH:", newHash);
  console.log("DETAILS URL:", props.zefixDetailWeb);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
