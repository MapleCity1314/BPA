export interface InventoryShopConfig {
  readonly id: string;
  readonly name: string;
  readonly browserInstanceId?: string;
}

export function prioritizeBrowserBoundShops(
  shops: readonly InventoryShopConfig[]
): readonly InventoryShopConfig[] {
  return [...shops].sort((left,right) =>
    Number(Boolean(right.browserInstanceId)) - Number(Boolean(left.browserInstanceId))
  );
}

export function schedulerShopIndexGroups(
  shops: readonly InventoryShopConfig[]
): { readonly bound: readonly number[]; readonly unbound: readonly number[] } {
  return {
    bound:shops.flatMap((shop,index) => shop.browserInstanceId ? [index] : []),
    unbound:shops.flatMap((shop,index) => shop.browserInstanceId ? [] : [index])
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${label}_INVALID`);
  }
  return value.trim();
}

export function inventoryShopsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly requireBrowserBindings?: boolean } = {}
): readonly InventoryShopConfig[] {
  const encoded = environment.BPA_INVENTORY_SHOPS_JSON?.trim();
  let shops: InventoryShopConfig[];
  if (encoded) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error("BPA_INVENTORY_SHOPS_JSON_INVALID");
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) {
      throw new Error("BPA_INVENTORY_SHOPS_JSON_INVALID");
    }
    shops = parsed.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`BPA_INVENTORY_SHOPS_JSON_${index}_INVALID`);
      }
      const shop = value as Record<string, unknown>;
      if (Object.keys(shop).some((key) => !["id", "name", "browserInstanceId"].includes(key))) {
        throw new Error(`BPA_INVENTORY_SHOPS_JSON_${index}_INVALID`);
      }
      const browserInstanceId = shop.browserInstanceId === undefined
        ? undefined
        : text(shop.browserInstanceId, `BPA_INVENTORY_SHOPS_JSON_${index}_BROWSER_INSTANCE_ID`);
      return {
        id: text(shop.id, `BPA_INVENTORY_SHOPS_JSON_${index}_ID`),
        name: text(shop.name, `BPA_INVENTORY_SHOPS_JSON_${index}_NAME`),
        ...(browserInstanceId ? { browserInstanceId } : {})
      };
    });
  } else {
    shops = [{
      id: text(environment.BPA_INVENTORY_SHOP_ID, "BPA_INVENTORY_SHOP_ID"),
      name: text(environment.BPA_INVENTORY_SHOP_NAME, "BPA_INVENTORY_SHOP_NAME"),
      ...(environment.BPA_INVENTORY_BROWSER_INSTANCE_ID?.trim()
        ? { browserInstanceId: text(environment.BPA_INVENTORY_BROWSER_INSTANCE_ID, "BPA_INVENTORY_BROWSER_INSTANCE_ID") }
        : {})
    }];
  }
  if (new Set(shops.map((shop) => shop.id)).size !== shops.length) {
    throw new Error("BPA_INVENTORY_SHOP_ID_DUPLICATE");
  }
  if (new Set(shops.map((shop) => shop.name)).size !== shops.length) {
    throw new Error("BPA_INVENTORY_SHOP_NAME_DUPLICATE");
  }
  const legacyShopId = environment.BPA_INVENTORY_SHOP_ID?.trim();
  const legacyBrowserInstanceId = environment.BPA_INVENTORY_BROWSER_INSTANCE_ID?.trim();
  if (encoded && legacyShopId && legacyBrowserInstanceId) {
    shops = shops.map((shop) => shop.id === legacyShopId && !shop.browserInstanceId
      ? { ...shop,browserInstanceId:text(legacyBrowserInstanceId,"BPA_INVENTORY_BROWSER_INSTANCE_ID") }
      : shop);
  }
  const configuredBrowserInstanceIds = shops.flatMap((shop) =>
    shop.browserInstanceId ? [shop.browserInstanceId] : []
  );
  if (new Set(configuredBrowserInstanceIds).size !== configuredBrowserInstanceIds.length) {
    throw new Error("MULTI_SHOP_BROWSER_INSTANCE_DUPLICATE");
  }
  if (shops.length > 1 && options.requireBrowserBindings) {
    if (shops.some((shop) => !shop.browserInstanceId)) {
      throw new Error("MULTI_SHOP_BROWSER_INSTANCE_REQUIRED");
    }
  }
  return shops;
}
