import { readDoudianShopContext } from "@bpa/adapter-doudian";

export default defineContentScript({
  matches: ["https://fxg.jinritemai.com/ffa/g/list*"],
  main() {
    browser.runtime.onMessage.addListener(
      (
        request: {
          type?: string;
          node?: { id?: string; version?: string };
          pageEpoch?: string;
        },
        _sender,
        sendResponse
      ) => {
        if (
          request.type !== "bpa.execute" ||
          request.node?.id !== "doudian.shop.context.read" ||
          request.node.version !== "1.0.0"
        ) {
          return undefined;
        }
        try {
          const context = readDoudianShopContext(document, location.href);
          sendResponse({
            ok: true,
            output: {
              ...context,
              page_epoch: request.pageEpoch
            }
          });
        } catch (error) {
          const code =
            error instanceof Error ? error.message : "ADAPTER_FAILED";
          sendResponse({
            ok: false,
            error: {
              code,
              message:
                code === "PAGE_LOADING"
                  ? "店铺信息尚未加载完成。"
                  : "当前页面不是受支持的抖店商品列表页。",
              retryable: code === "PAGE_LOADING"
            }
          });
        }
        return true;
      }
    );
  }
});
