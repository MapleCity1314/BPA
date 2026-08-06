function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function visible(element: HTMLElement): boolean {
  if (element.closest("[aria-hidden='true']")) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function knownAttributeOptimizationDialog(dialog: HTMLElement): boolean {
  const text = normalize(dialog.textContent);
  return (
    text.includes("立即开启") &&
    (text.includes("属性自动优化") ||
      (text.includes("若属性未填/填错") && text.includes("优化前通知商家")))
  );
}

/**
 * Dismisses only the explicitly allow-listed product-list marketing dialog.
 * Unknown visible dialogs remain blocking so a read-only workflow cannot
 * accidentally accept an agreement or enable a platform feature.
 */
export async function prepareDoudianProductList(
  doc: Document,
  wait: (milliseconds: number) => Promise<void>,
  waitMs: number
): Promise<number> {
  let dismissed = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialogs = Array.from(
      doc.querySelectorAll<HTMLElement>("[role='dialog']")
    ).filter(visible);
    const known = dialogs.filter(knownAttributeOptimizationDialog);
    if (known.length === 0) break;
    for (const dialog of known) {
      const close = dialog.querySelector<HTMLElement>(
        "button[aria-label='Close'],button[aria-label='close'],button[aria-label='关闭']"
      );
      if (!close) throw new Error("KNOWN_PRODUCT_PROMOTION_CLOSE_MISSING");
      close.click();
      dismissed += 1;
    }
    await wait(Math.max(300, waitMs));
    for (const dialog of known) {
      if (!visible(dialog) || !knownAttributeOptimizationDialog(dialog)) continue;
      dialog.style.display = "none";
      const mask = dialog.previousElementSibling;
      if (mask && /modal-mask/u.test(String(mask.className))) {
        (mask as HTMLElement).style.display = "none";
      }
    }
  }
  const remaining = Array.from(
    doc.querySelectorAll<HTMLElement>("[role='dialog']")
  ).filter(visible);
  if (remaining.length > 0) throw new Error("UNKNOWN_PRODUCT_LIST_DIALOG");
  return dismissed;
}
