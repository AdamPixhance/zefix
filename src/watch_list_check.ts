import { Zefix } from "./index";
import crypto from "crypto";
import fs from "fs";
import path from "path";

type State = Record<string, { hash: string; updatedAt: string; name?: string }>;
type WatchList = { companies: Array<{ uid: string; label?: string }> };

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
function sha256(obj: any): string {
  return crypto.createHash("sha256").update(stableStringify(obj)).digest("hex");
}
function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
function loadState(filePath: string): State {
  if (!fs.existsSync(filePath)) return {};
  return loadJson<State>(filePath);
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

  const listPath = path.resolve(process.cwd(), "watch_list.json");
  const statePath = path.resolve(process.cwd(), "watch_state.json");

  const watchList = loadJson<WatchList>(listPath);
  const state = loadState(statePath);

  let changedCount = 0;

  for (const item of watchList.companies) {
    const uid = item.uid;

    if (!zefix.isValidString(uid)) {
      console.log("SKIP invalid UID:", uid);
      continue;
    }

    const details = await zefix.getCompanyDetails(uid);
    if (!details) {
      console.log("SKIP no details for:", uid);
      continue;
    }

    // Normalize (same fields as demo)
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

    if (props.uid === null) {
      console.log("SKIP UID=null from details for:", uid);
      continue;
    }
    const uidKey: string = props.uid;

    const newHash = sha256(props);
    const prev = state[uidKey]?.hash;

    if (!prev) {
      state[uidKey] = { hash: newHash, updatedAt: new Date().toISOString(), name: props.name ?? undefined };
      console.log("BASELINE:", uidKey, item.label ?? props.name ?? "");
      continue;
    }

    if (prev !== newHash) {
      changedCount += 1;
      state[uidKey] = { hash: newHash, updatedAt: new Date().toISOString(), name: props.name ?? undefined };

      console.log("CHANGED:", uidKey, item.label ?? props.name ?? "");
      console.log("DETAILS URL:", props.zefixDetailWeb);
      // Later: send email/Slack here
    }
  }

  saveState(statePath, state);

  if (changedCount === 0) {
    console.log("DONE: no changes");
  } else {
    console.log(`DONE: ${changedCount} changed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
