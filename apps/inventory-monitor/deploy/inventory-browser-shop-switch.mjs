import { createHash } from "node:crypto";

const DEBUG_PORT = 17660;
const PRODUCT_LIST_URL =
  "https://fxg.jinritemai.com/ffa/g/list?sov_draft_status=0&sov_goodsType=0";
const ORDER_LIST_URL = "https://fxg.jinritemai.com/ffa/morder/order/list";
const TARGET_ORIGIN = "https://fxg.jinritemai.com";
const mode = process.argv[2];

function terminateForError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(message.includes("INVENTORY_BROWSER_LOGIN_REQUIRED") ? 42 : 1);
}
process.on("uncaughtException", terminateForError);
process.on("unhandledRejection", terminateForError);

function configuredShopNames() {
  const encoded = process.env.BPA_INVENTORY_SHOPS_JSON;
  if (!encoded) throw new Error("BPA_INVENTORY_SHOPS_JSON_REQUIRED");
  const shops = JSON.parse(encoded);
  if (!Array.isArray(shops) || shops.length === 0) {
    throw new Error("BPA_INVENTORY_SHOPS_JSON_INVALID");
  }
  return new Set(shops.map((shop) => String(shop?.name ?? "").trim()));
}

async function debugPages() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  if (!response.ok) throw new Error("INVENTORY_BROWSER_DEBUG_UNAVAILABLE");
  return response.json();
}

async function createDebugPage(url) {
  const response = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" }
  );
  if (!response.ok) throw new Error("INVENTORY_BROWSER_PAGE_CREATE_FAILED");
  return response.json();
}

async function closeExtraneousPages() {
  const pages = await debugPages();
  let closed = 0;
  for (const entry of pages) {
    if (entry.type !== "page") continue;
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      continue;
    }
    const keep = parsed.origin === TARGET_ORIGIN && (
      parsed.pathname === "/ffa/g/list" ||
      parsed.pathname === "/ffa/morder/order/list" ||
      parsed.pathname.startsWith("/login/")
    );
    if (keep) continue;
    const response = await fetch(
      `http://127.0.0.1:${DEBUG_PORT}/json/close/${encodeURIComponent(entry.id)}`
    );
    if (response.ok) closed += 1;
  }
  return closed;
}

function eligiblePage(pages) {
  const parsed = pages.flatMap((entry) => {
    if (entry.type !== "page") return [];
    try {
      return [{ entry, url: new URL(entry.url) }];
    } catch {
      return [];
    }
  });
  if (mode === "restore-orders" || mode === "status-orders") {
    return parsed.find(({ url }) =>
      url.origin === TARGET_ORIGIN && url.pathname === "/ffa/morder/order/list"
    )?.entry ?? parsed.find(({ url }) =>
      url.origin === TARGET_ORIGIN &&
        url.pathname.startsWith("/login/") &&
        decodeURIComponent(url.search).includes("/ffa/morder/order/list")
    )?.entry;
  }
  return parsed.find(({ url }) =>
    url.origin === TARGET_ORIGIN && url.pathname === "/ffa/g/list"
  )?.entry ?? parsed.find(({ url }) =>
    url.origin === TARGET_ORIGIN &&
      url.pathname.startsWith("/login/") &&
      decodeURIComponent(url.search).includes("/ffa/g/list")
  )?.entry ?? parsed.find(({ url }) =>
    url.origin === TARGET_ORIGIN && url.pathname !== "/ffa/morder/order/list"
  )?.entry;
}

let page = eligiblePage(await debugPages());
// Recycle the fixed worker tab at every restore boundary. DouDian's micro-app
// occasionally leaves a target with document.readyState=complete but a blank
// renderer after repeated RPA navigations. Reusing that target makes both the
// shop switcher and the inventory adapter see an invisible stale shell. Closing
// exactly the worker tab and creating one replacement keeps the tab lifecycle
// bounded while preserving the authenticated browser profile.
if (page && (mode === "restore-product" || mode === "restore-orders")) {
  const replacementUrl = mode === "restore-product" ? PRODUCT_LIST_URL : ORDER_LIST_URL;
  const response = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/close/${encodeURIComponent(page.id)}`
  );
  if (!response.ok) throw new Error("INVENTORY_BROWSER_PAGE_RECYCLE_FAILED");
  page = await createDebugPage(replacementUrl);
}
if (!page && mode === "restore-orders") {
  page = await createDebugPage(ORDER_LIST_URL);
}
if (!page && mode === "restore-product") {
  page = await createDebugPage(PRODUCT_LIST_URL);
}
if (!page) throw new Error("INVENTORY_BROWSER_PAGE_NOT_FOUND");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let messageId = 1;
async function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = messageId++;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(message.error.message));
      else if (message.result.exceptionDetails) {
        reject(new Error(
          message.result.exceptionDetails.exception?.description ??
          message.result.exceptionDetails.text ??
          "INVENTORY_BROWSER_EVALUATION_FAILED"
        ));
      } else resolve(message.result);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await request("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.result.value;
}

async function trustedClick(point) {
  await request("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const type of ["mousePressed", "mouseReleased"]) {
    await request("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
  }
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function center(expression) {
  return JSON.parse(await evaluate(`(() => {
    const element = ${expression};
    if (!element) throw new Error("CLICK_TARGET_NOT_FOUND");
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`));
}

async function optionalCenter(expression) {
  return JSON.parse(await evaluate(`(() => {
    const element = ${expression};
    if (!element) return "null";
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`));
}

async function productPageReady() {
  try {
    return await evaluate(`(() => ({
      path: location.pathname,
      ready: document.readyState,
      shopControl: Array.from(document.querySelectorAll(".index_userName__16Isl"))
        .some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
        })
    }))()`);
  } catch {
    return null;
  }
}

async function waitForProductPage(timeoutMilliseconds = 60_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await productPageReady();
    if (state?.path?.startsWith("/login/")) {
      throw new Error("INVENTORY_BROWSER_LOGIN_REQUIRED");
    }
    if (state?.path === "/ffa/g/list" &&
        state.ready === "complete" &&
        state.shopControl) return state;
    await wait(500);
  }
  throw new Error("INVENTORY_PRODUCT_PAGE_NOT_READY");
}

async function waitForOrdersPage(timeoutMilliseconds = 60_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(`({ path:location.pathname,ready:document.readyState })`);
      if (state?.path?.startsWith("/login/")) {
        throw new Error("INVENTORY_BROWSER_LOGIN_REQUIRED");
      }
      if (state?.path === "/ffa/morder/order/list" && state.ready === "complete") {
        return state;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("INVENTORY_BROWSER_LOGIN_REQUIRED")) {
        throw error;
      }
      // Navigation replaces the execution context briefly; continue polling.
    }
    await wait(500);
  }
  throw new Error("INVENTORY_ORDER_PAGE_NOT_READY");
}

async function waitForShopContext(targetShopName, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const current = await evaluate(`(() => {
        const element = Array.from(document.querySelectorAll(".index_userName__16Isl"))
          .find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && candidate.getClientRects().length > 0;
          });
        return (element?.textContent || "").replace(/\\s+/g, " ").trim();
      })()`);
      if (current === targetShopName) return current;
    } catch {
      // The page's execution context is briefly unavailable during shop navigation.
    }
    await wait(500);
  }
  throw new Error(`INVENTORY_SHOP_CONTEXT_NOT_READY:${targetShopName}`);
}

if (mode === "restore-product") {
  await request("Page.navigate", { url: PRODUCT_LIST_URL });
  await waitForProductPage();
  await request("Page.bringToFront");
  await closeExtraneousPages();
  await wait(750);
  socket.close();
  process.stdout.write("product-navigation-ready\n");
  process.exit(0);
}

if (mode === "restore-orders") {
  await request("Page.navigate", { url: ORDER_LIST_URL });
  await waitForOrdersPage();
  await request("Page.bringToFront");
  await closeExtraneousPages();
  await wait(750);
  socket.close();
  process.stdout.write("order-navigation-ready\n");
  process.exit(0);
}

if (mode === "status-orders") {
  const status = await evaluate(`(() => ({
    url:location.href,
    ready:document.readyState,
    title:document.title,
    text:(document.body?.innerText || "").replace(/\\s+/g," ").trim().slice(0,800),
    loginInput:Boolean(document.querySelector('input[name="mobile"],input[name="mobilecaptcha"]'))
  }))()`);
  socket.close();
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exit(0);
}

if (mode === "dismiss-known-modal") {
  const dismissed = await evaluate(`(() => {
    const normalize = (value) => (value || "").replace(/\\s+/g," ").trim();
    const candidates = Array.from(document.querySelectorAll(
      "[role='dialog'],.ecom-g-modal-root,.ecom-g-modal-wrap,.ecom-g-modal-mask"
    ));
    const known = candidates.filter((element) => {
      const text = normalize(element.textContent);
      return text.includes("立即开启") &&
        (text.includes("属性自动优化") || text.includes("若属性未填/填错"));
    });
    for (const element of known) element.style.display="none";
    return known.length;
  })()`);
  socket.close();
  process.stdout.write(`${JSON.stringify({ dismissed })}\n`);
  process.exit(0);
}

if (mode === "canary") {
  const expectedShopName = String(process.argv[3] ?? "").trim();
  if (!configuredShopNames().has(expectedShopName)) {
    throw new Error(`INVENTORY_BROWSER_SHOP_NOT_ALLOWLISTED:${expectedShopName}`);
  }
  await waitForProductPage();
  const sample = async () => evaluate(`(() => {
    const normalize = (value) => (value || "").replace(/\\s+/g," ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
    };
    const shop = Array.from(document.querySelectorAll(".index_userName__16Isl"))
      .find(visible)?.textContent;
    const tables = Array.from(document.querySelectorAll("table"));
    const headers = tables.flatMap((table) =>
      Array.from(table.querySelectorAll("thead th,[role='columnheader']"))
        .map((header) => normalize(header.textContent))
    );
    const productRows = Array.from(document.querySelectorAll("tr"))
      .filter((row) => /(?:商品|product)[-_]?(?:id)?[：:]?\\s*\\d{5,30}/iu.test(normalize(row.textContent)) ||
        row.querySelector("a[href*='product_id='],[data-row-key]")).length;
    const dialogs = Array.from(document.querySelectorAll(
      "[role='dialog'],.ecom-g-modal-root,.ecom-g-modal-wrap,.auxo-modal"
    )).filter(visible).map((element) => normalize(element.textContent).slice(0,240));
    const unknownDialogs = dialogs.filter((text) => !(text.includes("立即开启") &&
      (text.includes("属性自动优化") || text.includes("若属性未填/填错"))));
    return {
      shop:normalize(shop),path:location.pathname,ready:document.readyState,
      headers:[...new Set(headers)].sort(),productRows,unknownDialogs
    };
  })()`);
  const first = await sample();
  await wait(750);
  const second = await sample();
  if (second.shop !== expectedShopName) {
    throw new Error(`INVENTORY_CANARY_SHOP_MISMATCH:${second.shop || "unknown"}`);
  }
  if (second.path !== "/ffa/g/list" || second.ready !== "complete") {
    throw new Error("INVENTORY_CANARY_PAGE_NOT_READY");
  }
  if (!second.headers.includes("总库存") || !second.headers.some((value) => value.includes("商品"))) {
    throw new Error("INVENTORY_CANARY_STRUCTURE_CHANGED");
  }
  if (second.unknownDialogs.length > 0) {
    throw new Error("INVENTORY_CANARY_UNKNOWN_DIALOG");
  }
  const signature = JSON.stringify({
    shop:second.shop,path:second.path,headers:second.headers,productRows:second.productRows
  });
  const firstSignature = JSON.stringify({
    shop:first.shop,path:first.path,headers:first.headers,productRows:first.productRows
  });
  if (signature !== firstSignature) throw new Error("INVENTORY_CANARY_NOT_STABLE");
  socket.close();
  process.stdout.write(`${JSON.stringify({
    status:"passed",shop:second.shop,productRows:second.productRows,
    structureDigest:`sha256:${createHash("sha256").update(signature).digest("hex")}`
  })}\n`);
  process.exit(0);
}

if (mode === "status") {
  const status = await evaluate(`(() => {
    const triggers = Array.from(document.querySelectorAll(".index_userName__16Isl"));
    const trigger = triggers.find((candidate) => {
      const candidateRect = candidate.getBoundingClientRect();
      return candidateRect.width > 0 && candidateRect.height > 0 && candidate.getClientRects().length > 0;
    });
    const rect = trigger?.getBoundingClientRect();
    const point = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    const hit = point ? document.elementFromPoint(point.x, point.y) : null;
    return {
      url: location.href,
      ready: document.readyState,
      trigger: trigger ? {
        text: trigger.textContent?.replace(/\\s+/g, " ").trim(),
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      } : null,
      triggerCount: triggers.length,
      stopPages: Array.from(document.querySelectorAll(".in-stop-modal-time-page"))
        .map((element) => {
          const elementRect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            className: String(element.className),
            inlineStyle: element.getAttribute("style"),
            display: style.display,
            visibility: style.visibility,
            rect: { width: elementRect.width, height: elementRect.height },
            text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
            childCount: element.childElementCount,
            parentClassName: String(element.parentElement?.className || "")
          };
        }),
      hit: hit ? { tag: hit.tagName, className: String(hit.className), text: hit.textContent?.replace(/\\s+/g, " ").trim() } : null,
      visibleDialogs: Array.from(document.querySelectorAll("[role='dialog'], .auxo-modal, [class*='modal']"))
        .filter((element) => element.getClientRects().length > 0)
        .slice(0, 10)
        .map((element) => ({ className: String(element.className), text: element.textContent?.replace(/\\s+/g, " ").trim().slice(0, 160) })),
      switchEntries: Array.from(document.querySelectorAll("body *"))
        .filter((element) => (element.textContent || "").replace(/\\s+/g, " ").trim() === "切换组织/店铺")
        .map((element) => ({ className: String(element.className), visible: element.getClientRects().length > 0 }))
    };
  })()`);
  socket.close();
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exit(0);
}

if (mode !== "switch") throw new Error("INVENTORY_BROWSER_MODE_INVALID");
const targetShopName = String(process.argv[3] ?? "").trim();
if (!configuredShopNames().has(targetShopName)) {
  throw new Error(`INVENTORY_BROWSER_SHOP_NOT_ALLOWLISTED:${targetShopName}`);
}
await waitForProductPage();
const currentShopName = await evaluate(`(() =>
  (Array.from(document.querySelectorAll(".index_userName__16Isl"))
    .find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && candidate.getClientRects().length > 0;
    })?.textContent || "")
    .replace(/\\s+/g," ").trim()
)()`);
if (currentShopName === targetShopName) {
  socket.close();
  process.stdout.write(`${JSON.stringify({ switchedTo:targetShopName,alreadySelected:true })}\n`);
  process.exit(0);
}

await evaluate(`(() => {
  const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
  for (const dialog of document.querySelectorAll(
    "[role='dialog'],.ecom-g-modal-root,.ecom-g-modal-wrap,.ecom-g-modal-mask"
  )) {
    const text = normalize(dialog.textContent);
    if (!text.includes("立即开启") ||
        !(text.includes("属性自动优化") || text.includes("若属性未填/填错"))) continue;
    dialog.style.display = "none";
    const mask = dialog.previousElementSibling;
    if (mask && String(mask.className).includes("modal-mask")) mask.style.display = "none";
  }
  return true;
})()`);

let choices = [];
const readChoices = async () => JSON.parse(await evaluate(`JSON.stringify(Array.from(
  document.querySelectorAll(".index_introName__fRtLx")
).filter((element) => element.getClientRects().length > 0)
  .map((element) => (element.textContent || "").replace(/\\s+/g, " ").trim()))`));

choices = await readChoices();
if (choices.length === 0) {
  await waitForProductPage();
  const switchEntryExpression = `Array.from(document.querySelectorAll("body *"))
    .filter((element) => (element.textContent || "").replace(/\\s+/g, " ").trim() === "切换组织/店铺")
    .filter((element) => element.getClientRects().length > 0)
    .sort((left, right) => left.children.length - right.children.length)[0]`;
  let switchPoint = await optionalCenter(switchEntryExpression);
  if (!switchPoint) {
    await trustedClick(await center(
      `Array.from(document.querySelectorAll(".index_userName__16Isl"))
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && candidate.getClientRects().length > 0;
        })`
    ));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(500);
      switchPoint = await optionalCenter(switchEntryExpression);
      if (switchPoint) break;
    }
  }
  if (!switchPoint) throw new Error("INVENTORY_SHOP_SWITCH_ENTRY_NOT_READY");
  const switchClicked = await evaluate(`(() => {
    const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
    const element = Array.from(document.querySelectorAll("body *"))
      .filter((candidate) => normalize(candidate.textContent) === "切换组织/店铺")
      .filter((candidate) => candidate.getClientRects().length > 0)
      .find((candidate) => String(candidate.className).includes("index_descriptions__"));
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!switchClicked) await trustedClick(switchPoint);
}

for (let attempt = 0; attempt < 20; attempt += 1) {
  await wait(500);
  choices = await readChoices();
  if (choices.length > 0) break;
}
if (!choices.includes(targetShopName)) {
  throw new Error(`INVENTORY_BROWSER_TARGET_NOT_AVAILABLE:${targetShopName}`);
}
await evaluate(`(() => {
  const target = Array.from(document.querySelectorAll(".index_introName__fRtLx"))
    .find((element) => (element.textContent || "").replace(/\\s+/g, " ").trim() === ${JSON.stringify(targetShopName)});
  if (!target) throw new Error("INVENTORY_BROWSER_TARGET_DISAPPEARED");
  target.click();
  return true;
})()`);
await waitForShopContext(targetShopName);
socket.close();
process.stdout.write(`${JSON.stringify({ switchedTo: targetShopName })}\n`);
